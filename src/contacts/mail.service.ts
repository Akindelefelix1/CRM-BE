import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { contacts } from '../database/schema.js';

type ContactRecord = typeof contacts.$inferSelect;

@Injectable()
export class MailService {
  async sendCampaignTestEmail(
    toValue: unknown,
    subjectValue: unknown,
    blocks: unknown,
  ) {
    if (typeof toValue !== 'string' || !/^\S+@\S+\.\S+$/.test(toValue.trim())) {
      throw new BadRequestException('Enter a valid test email address');
    }
    const now = new Date();
    const recipient = {
      id: 'campaign-test',
      firstName: 'Test',
      lastName: 'Recipient',
      email: toValue.trim(),
      alternateEmails: [],
      phone: null,
      organization: null,
      category: 'Uncategorized',
      location: null,
      interests: [],
      tags: [],
      emailConsent: 'Subscribed' as const,
      smsConsent: 'Pending' as const,
      whatsappConsent: 'Pending' as const,
      createdAt: now,
      updatedAt: now,
    } satisfies ContactRecord;
    return this.sendCampaignEmail(
      recipient,
      this.readText(subjectValue, 'subject', 200),
      blocks,
      `test-${crypto.randomUUID()}`,
    );
  }

  async sendContactEmail(
    contact: ContactRecord,
    input: Record<string, unknown>,
  ) {
    if (contact.emailConsent !== 'Subscribed') {
      throw new BadRequestException(
        'Email can only be sent to contacts with subscribed email consent',
      );
    }

    const subjectTemplate = this.readText(input.subject, 'subject', 200);
    const bodyTemplate = this.readText(input.body, 'body', 10000);
    if (/[\r\n]/.test(subjectTemplate)) {
      throw new BadRequestException('subject must fit on a single line');
    }
    const subject = this.personalize(subjectTemplate, contact);
    const body = this.personalize(bodyTemplate, contact);
    await this.send(
      contact,
      subject,
      body,
      `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${this.escapeHtml(body)}</div>`,
      `contact-${contact.id}`,
    );
    return { sent: true, to: contact.email };
  }

  async sendCampaignEmail(
    contact: ContactRecord,
    subjectTemplate: string,
    blocks: unknown,
    campaignId: string,
  ) {
    if (contact.emailConsent !== 'Subscribed') {
      throw new BadRequestException(
        'Email can only be sent to contacts with subscribed email consent',
      );
    }
    const subject = this.personalize(
      this.readText(subjectTemplate, 'subject', 200),
      contact,
    );
    if (/\r\n/.test(subject))
      throw new BadRequestException('subject must fit on a single line');
    if (!Array.isArray(blocks))
      throw new BadRequestException('Email content blocks are invalid');
    let text = '';
    let html = '';
    for (const item of blocks) {
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      const content =
        typeof block.content === 'string'
          ? this.personalize(block.content, contact)
          : '';
      const safe = this.escapeHtml(content).replace(/\n/g, '<br>');
      switch (block.type) {
        case 'text':
          text += `${content}\n\n`;
          html += `<p>${safe}</p>`;
          break;
        case 'divider':
          text += '\n';
          html += '<hr>';
          break;
        case 'image': {
          const url = this.safeHttpsUrl(
            typeof block.content === 'string'
              ? this.personalize(block.content, contact)
              : '',
          );
          if (url)
            html += `<p><img src="${this.escapeHtml(url)}" alt="Email image" style="max-width:100%;height:auto"></p>`;
          break;
        }
        case 'link':
        case 'button': {
          const url = this.safeHttpsUrl(
            typeof block.url === 'string'
              ? this.personalize(block.url, contact)
              : '',
          );
          if (url) {
            text += `${content}: ${url}\n`;
            html += `<p><a href="${this.escapeHtml(url)}">${safe || this.escapeHtml(url)}</a></p>`;
          } else if (content) {
            text += `${content}\n`;
            html += `<p>${safe}</p>`;
          }
          break;
        }
      }
    }
    if (!text.trim() && !html.trim())
      throw new BadRequestException('Email content is empty');
    await this.send(
      contact,
      subject,
      text.trim() || subject,
      `<div style="font-family:Arial,sans-serif;line-height:1.6">${html}</div>`,
      `campaign-${campaignId}-${contact.id}`,
    );
    return { sent: true, to: contact.email };
  }

  private async send(
    contact: ContactRecord,
    subject: string,
    body: string,
    htmlBody: string,
    reference: string,
  ) {
    const endpoint = process.env.ZOHO_MAIL_API_URL?.trim();
    const token = process.env.ZOHO_MAIL_API_TOKEN?.trim();
    const fromAddress = process.env.ZOHO_MAIL_FROM?.trim();
    const fromName = process.env.ZOHO_MAIL_FROM_NAME?.trim() || 'Cephas CRM';

    if (!endpoint || !token || !fromAddress) {
      throw new ServiceUnavailableException(
        'Email sending is not configured on the API',
      );
    }
    // Render may store the full copied authorization value, including the
    // scheme. Normalize both that form and a bare key to one valid header.
    const apiKey = token.replace(/^Zoho-enczapikey\s+/i, '').trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'The configured email provider key is empty',
      );
    }
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new ServiceUnavailableException(
        'The configured email provider URL is invalid',
      );
    }
    if (parsedEndpoint.protocol !== 'https:') {
      throw new ServiceUnavailableException(
        'The email provider must use HTTPS',
      );
    }
    // Zoho's current ZeptoMail Mail Send API uses the CPaaS endpoint. Keep
    // older Render/.env configurations working by translating the legacy
    // api.zeptomail.com host while preserving its API path and query string.
    if (parsedEndpoint.hostname === 'api.zeptomail.com') {
      parsedEndpoint.hostname = 'cpaas.zoho.com';
    } else if (parsedEndpoint.hostname === 'api.zeptomail.eu') {
      parsedEndpoint.hostname = 'cpaas.zoho.eu';
    }

    const timeout = Number(process.env.MAIL_SEND_TIMEOUT_MS);
    try {
      const response = await fetch(parsedEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Zoho-enczapikey ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          from: { address: fromAddress, name: fromName },
          to: [
            {
              email_address: {
                address: contact.email,
                name: [contact.firstName, contact.lastName]
                  .filter(Boolean)
                  .join(' '),
              },
            },
          ],
          subject,
          textbody: body,
          htmlbody: htmlBody,
          client_reference: reference,
        }),
        signal: AbortSignal.timeout(
          Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
        ),
      });
      if (!response.ok) {
        const responseBody = await response.text().catch(() => '');
        let providerMessage = '';
        try {
          const payload = JSON.parse(responseBody) as {
            message?: unknown;
            error?: unknown;
            code?: unknown;
            error_code?: unknown;
          };
          const detail = [
            payload.message,
            payload.error,
            payload.code,
            payload.error_code,
          ].find((value) => typeof value === 'string' && value.trim());
          if (typeof detail === 'string')
            providerMessage = detail.replace(/\s+/g, ' ').slice(0, 240);
        } catch {
          // Do not log or return an unstructured provider response.
        }
        throw new BadGatewayException(
          `Zoho could not send the email (HTTP ${response.status})${providerMessage ? `: ${providerMessage}` : ''}`,
        );
      }
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BadGatewayException(
          'Zoho email sending timed out. Please retry.',
        );
      }
      throw new BadGatewayException(
        'Could not connect to Zoho email. Please retry.',
      );
    }
  }

  private safeHttpsUrl(value: string) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.toString() : '';
    } catch {
      return '';
    }
  }

  private readText(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    const text = value.trim();
    if (text.length > maxLength) {
      throw new BadRequestException(
        `${field} may not exceed ${maxLength} characters`,
      );
    }
    return text;
  }

  private personalize(template: string, contact: ContactRecord) {
    const name = [contact.firstName, contact.lastName]
      .filter(Boolean)
      .join(' ');
    const values: Record<string, string> = {
      first_name: contact.firstName,
      last_name: contact.lastName,
      name,
      full_name: name,
      email: contact.email,
      organization: contact.organization ?? '',
      location: contact.location ?? '',
    };
    return template.replace(
      /\{\{\s*([a-z_]+)\s*\}\}/gi,
      (match, key: string) =>
        Object.hasOwn(values, key.toLowerCase())
          ? values[key.toLowerCase()]
          : match,
    );
  }

  private escapeHtml(value: string) {
    return value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]!,
    );
  }
}

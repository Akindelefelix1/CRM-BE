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
  async sendContactEmail(contact: ContactRecord, input: Record<string, unknown>) {
    if (contact.emailConsent !== 'Subscribed') {
      throw new BadRequestException('Email can only be sent to contacts with subscribed email consent');
    }

    const subjectTemplate = this.readText(input.subject, 'subject', 200);
    const bodyTemplate = this.readText(input.body, 'body', 10000);
    if (/[\r\n]/.test(subjectTemplate)) {
      throw new BadRequestException('subject must fit on a single line');
    }
    const subject = this.personalize(subjectTemplate, contact);
    const body = this.personalize(bodyTemplate, contact);
    const endpoint = process.env.ZOHO_MAIL_API_URL?.trim();
    const token = process.env.ZOHO_MAIL_API_TOKEN?.trim();
    const fromAddress = process.env.ZOHO_MAIL_FROM?.trim();
    const fromName = process.env.ZOHO_MAIL_FROM_NAME?.trim() || 'Cephas CRM';

    if (!endpoint || !token || !fromAddress) {
      throw new ServiceUnavailableException('Email sending is not configured on the API');
    }
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new ServiceUnavailableException('The configured email provider URL is invalid');
    }
    if (parsedEndpoint.protocol !== 'https:') {
      throw new ServiceUnavailableException('The email provider must use HTTPS');
    }

    const timeout = Number(process.env.MAIL_SEND_TIMEOUT_MS);
    try {
      const response = await fetch(parsedEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Zoho-enczapikey ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          from: { address: fromAddress, name: fromName },
          to: [{ email_address: { address: contact.email, name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') } }],
          subject,
          textbody: body,
          htmlbody: `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${this.escapeHtml(body)}</div>`,
          client_reference: `contact-${contact.id}`,
        }),
        signal: AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : 15000),
      });
      if (!response.ok) {
        throw new BadGatewayException(`Zoho could not send the email (HTTP ${response.status})`);
      }
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BadGatewayException('Zoho email sending timed out. Please retry.');
      }
      throw new BadGatewayException('Could not connect to Zoho email. Please retry.');
    }

    return { sent: true, to: contact.email };
  }

  private readText(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    const text = value.trim();
    if (text.length > maxLength) {
      throw new BadRequestException(`${field} may not exceed ${maxLength} characters`);
    }
    return text;
  }

  private personalize(template: string, contact: ContactRecord) {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const values: Record<string, string> = {
      first_name: contact.firstName,
      last_name: contact.lastName,
      name,
      full_name: name,
      email: contact.email,
      organization: contact.organization ?? '',
      location: contact.location ?? '',
    };
    return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) =>
      Object.hasOwn(values, key.toLowerCase()) ? values[key.toLowerCase()] : match,
    );
  }

  private escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]!);
  }
}

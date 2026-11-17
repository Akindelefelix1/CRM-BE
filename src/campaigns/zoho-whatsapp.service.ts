import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

type ZohoEnvelope = {
  data?: {
    code?: string;
    message?: string;
    message_id?: string;
    status?: string;
  };
  error?: { code?: string; message?: string };
};

@Injectable()
export class ZohoWhatsAppService {
  private get configuration() {
    const apiKey = process.env.ZOHO_WHATSAPP_API_KEY?.trim();
    if (!apiKey)
      throw new ServiceUnavailableException(
        'WhatsApp delivery is not configured. Add ZOHO_WHATSAPP_API_KEY to the CRM API environment.',
      );
    return {
      apiKey,
      baseUrl: (
        process.env.ZOHO_WHATSAPP_API_URL || 'https://cpaas.zoho.com/v1.1/whatsapp'
      ).replace(/\/$/, ''),
    };
  }

  configured() {
    return Boolean(process.env.ZOHO_WHATSAPP_API_KEY?.trim());
  }

  async send(input: {
    from: string;
    to: string;
    template: string;
    mergeInfo: Record<string, string>;
    clientReference: string;
  }) {
    const { apiKey, baseUrl } = this.configuration;
    const isTemplateKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.template);
    const payload = {
      from: input.from,
      to: input.to,
      ...(isTemplateKey
        ? { template_key: input.template }
        : { template_alias: input.template }),
      ...(Object.keys(input.mergeInfo).length ? { merge_info: input.mergeInfo } : {}),
      ...(process.env.ZOHO_WHATSAPP_AGENT_ID?.trim()
        ? { agent_id: process.env.ZOHO_WHATSAPP_AGENT_ID.trim() }
        : {}),
      client_reference: input.clientReference,
    };
    const body = await this.call(`${baseUrl}`, apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!body.data?.message_id || body.data.status !== 'success')
      throw new BadGatewayException(
        body.error?.message || body.data?.message || 'Zoho CPaaS did not queue this WhatsApp message',
      );
    return body.data;
  }

  async getMessage(messageId: string) {
    const { apiKey, baseUrl } = this.configuration;
    return this.call(`${baseUrl}/logs/${encodeURIComponent(messageId)}`, apiKey);
  }

  private async call(url: string, apiKey: string, init?: RequestInit) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Zoho-enczapikey ${apiKey}`,
          Accept: 'application/json',
          ...init?.headers,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new BadGatewayException('Could not reach Zoho CPaaS WhatsApp');
    }
    const body = (await response.json().catch(() => ({}))) as ZohoEnvelope;
    if (!response.ok || body.error)
      throw new BadGatewayException(
        body.error?.message || body.data?.message || `Zoho CPaaS returned HTTP ${response.status}`,
      );
    return body;
  }
}

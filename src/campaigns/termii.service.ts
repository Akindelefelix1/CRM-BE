import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

type TermiiResult = {
  message_id?: string | number;
  code?: string;
  message?: string;
  balance?: number;
};

type TermiiSender = {
  sender_id?: string;
  status?: string;
  country?: string;
};

@Injectable()
export class TermiiService {
  async testConnection() {
    const apiKey = process.env.TERMII_API_KEY?.trim();
    if (!apiKey)
      throw new ServiceUnavailableException(
        'SMS delivery is not configured. Add TERMII_API_KEY to the API environment.',
      );
    const baseUrl = (
      process.env.TERMII_BASE_URL || 'https://api.ng.termii.com'
    ).replace(/\/$/, '');
    const balanceUrl = new URL(`${baseUrl}/api/get-balance`);
    balanceUrl.searchParams.set('api_key', apiKey);

    let balanceResponse: Response;
    try {
      balanceResponse = await fetch(balanceUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BadGatewayException('Could not reach the Termii SMS service');
    }
    const balance = (await balanceResponse.json().catch(() => null)) as
      | { balance?: number; currency?: string; message?: string }
      | null;
    if (
      !balanceResponse.ok ||
      !balance ||
      typeof balance.balance !== 'number' ||
      typeof balance.currency !== 'string'
    ) {
      throw new BadGatewayException(
        typeof balance?.message === 'string'
          ? balance.message.slice(0, 300)
          : 'Termii rejected the API key or returned an invalid wallet response.',
      );
    }

    const configuredSenderId = process.env.TERMII_SENDER_ID?.trim() || null;
    let senderIds: { senderId: string; status: string; country: string | null }[] = [];
    const senderUrl = new URL(`${baseUrl}/api/sender-id`);
    senderUrl.searchParams.set('api_key', apiKey);
    if (configuredSenderId)
      senderUrl.searchParams.set('name', configuredSenderId);
    try {
      const senderResponse = await fetch(senderUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const senderPayload = (await senderResponse.json().catch(() => null)) as
        | { content?: TermiiSender[]; message?: string }
        | null;
      if (senderResponse.ok && Array.isArray(senderPayload?.content)) {
        senderIds = senderPayload.content.flatMap((item) =>
          typeof item.sender_id === 'string'
            ? [{
                senderId: item.sender_id,
                status: typeof item.status === 'string' ? item.status : 'unknown',
                country: typeof item.country === 'string' ? item.country : null,
              }]
            : [],
        );
      }
    } catch {
      // Balance is enough to verify credentials. Sender ID lookup is supplemental.
    }
    const configuredSender = configuredSenderId
      ? senderIds.find(
          (item) =>
            item.senderId.toLowerCase() === configuredSenderId.toLowerCase(),
        ) ?? null
      : null;
    return {
      connected: true,
      provider: 'Termii',
      balance: balance.balance,
      currency: balance.currency,
      senderId: configuredSenderId,
      senderIdStatus: configuredSender?.status ?? null,
      senderIds,
    };
  }

  async sendBulk(to: string[], message: string, senderId: string) {
    const apiKey = process.env.TERMII_API_KEY?.trim();
    if (!apiKey)
      throw new ServiceUnavailableException(
        'SMS delivery is not configured. Add TERMII_API_KEY to the API environment.',
      );
    if (to.length < 1 || to.length > 100)
      throw new BadGatewayException('Termii bulk sends require 1 to 100 numbers');

    const baseUrl = (
      process.env.TERMII_BASE_URL || 'https://api.ng.termii.com'
    ).replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/sms/send/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          to,
          from: senderId,
          sms: message,
          type: 'plain',
          channel: process.env.TERMII_CHANNEL?.trim() || 'generic',
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new BadGatewayException('Could not reach the Termii SMS service');
    }

    const body = (await response.json().catch(() => null)) as TermiiResult | null;
    if (
      !response.ok ||
      !body ||
      typeof body.code !== 'string' ||
      body.code.toLowerCase() !== 'ok' ||
      !(typeof body.message_id === 'string' || typeof body.message_id === 'number')
    ) {
      const detail =
        typeof body?.message === 'string' ? body.message : 'Termii rejected the SMS batch';
      throw new BadGatewayException(detail.slice(0, 500));
    }
    return body;
  }

  normalizePhone(phone: string | null) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (!digits) return null;
    const countryCode = (process.env.TERMII_COUNTRY_CODE || '234').replace(/\D/g, '');
    let international: string;
    if (phone.trim().startsWith('+')) international = digits;
    else if (digits.startsWith(countryCode)) international = digits;
    else international = `${countryCode}${digits.replace(/^0+/, '')}`;
    return /^\d{8,15}$/.test(international) ? international : null;
  }
}

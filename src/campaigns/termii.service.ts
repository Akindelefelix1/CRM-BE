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

@Injectable()
export class TermiiService {
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

    const body = (await response.json().catch(() => ({}))) as TermiiResult;
    if (!response.ok || (body.code && body.code.toLowerCase() !== 'ok')) {
      const detail =
        typeof body.message === 'string' ? body.message : 'Termii rejected the SMS batch';
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

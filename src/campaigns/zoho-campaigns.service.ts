import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { campaigns, contacts } from '../database/schema.js';

type CampaignRecord = typeof campaigns.$inferSelect;
type ContactRecord = typeof contacts.$inferSelect;

@Injectable()
export class ZohoCampaignsService {
  private cachedToken = '';
  private tokenExpiresAt = 0;

  async createMailingList(
    campaign: CampaignRecord,
    recipients: ContactRecord[],
    existingKey?: string,
    onCreated?: (key: string) => Promise<void>,
  ) {
    if (!recipients.length)
      throw new BadGatewayException(
        'No eligible recipients were found for this campaign',
      );
    let listKey = existingKey ?? '';
    const topicId = process.env.ZOHO_CAMPAIGNS_TOPIC_ID?.trim();
    // addlistandcontacts creates the list and subscribes the initial batch in
    // one request. Do not submit those first addresses again below: duplicate
    // subscribe requests can be rejected by Zoho and prevent later batches
    // from being synchronized.
    let nextRecipientIndex = 0;
    if (!listKey) {
      const firstBatch = recipients
        .slice(0, 10)
        .map((contact) => contact.email)
        .join(',');
      const listName =
        `Cephas ${campaign.id.slice(0, 8)} ${campaign.name}`.slice(0, 100);
      const created = await this.call(
        'addlistandcontacts',
        {
          resfmt: 'json',
          listname: listName,
          signupform: 'private',
          mode: 'newlist',
          listdescription: `Cephas CRM audience for campaign ${campaign.name}`,
          emailids: firstBatch,
        },
        'ZohoCampaigns.contact.CREATE',
      );
      listKey = this.value(created, 'listkey');
      if (!listKey)
        throw new BadGatewayException(
          'Zoho Campaigns did not return a mailing list key',
        );
      await onCreated?.(listKey);
      nextRecipientIndex = Math.min(recipients.length, 10);
    }
    // In accounts using Zoho's topic management, every campaign recipient must
    // be subscribed to the campaign topic. addlistandcontacts has no topic_id
    // parameter, so subscribe the initial batch again through listsubscribe.
    for (
      let index = topicId ? 0 : nextRecipientIndex;
      index < recipients.length;
      index += 10
    ) {
      const batch = recipients.slice(index, index + 10);
      await Promise.all(
        batch.map((contact) =>
          this.call(
            'json/listsubscribe',
            {
              resfmt: 'json',
              listkey: listKey,
              contactinfo: JSON.stringify({
                'First Name': contact.firstName,
                'Last Name': contact.lastName,
                'Contact Email': contact.email,
              }),
              source: 'Cephas CRM',
              ...(topicId ? { topic_id: topicId } : {}),
            },
            'ZohoCampaigns.contact.UPDATE',
          ),
        ),
      );
    }
    return listKey;
  }

  async createCampaign(campaign: CampaignRecord, listKey: string) {
    const publicApiUrl = (
      process.env.API_PUBLIC_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      ''
    ).replace(/\/$/, '');
    if (!publicApiUrl)
      throw new ServiceUnavailableException(
        'Set API_PUBLIC_URL to the publicly reachable CRM API URL to let Zoho Campaigns fetch campaign content',
      );
    const fromEmail = process.env.ZOHO_CAMPAIGNS_FROM_EMAIL?.trim();
    if (!fromEmail)
      throw new ServiceUnavailableException(
        'Zoho Campaigns sender email is not configured',
      );
    const response = await this.call(
      'createCampaign',
      {
        resfmt: 'json',
        campaignname: campaign.name,
        from_email: fromEmail,
        from_name: process.env.ZOHO_CAMPAIGNS_FROM_NAME?.trim() || 'Cephas CRM',
        subject: campaign.subject,
        content_url: `${publicApiUrl}/api/campaigns/${encodeURIComponent(campaign.id)}/content`,
        list_details: JSON.stringify({ [listKey]: [] }),
        ...(process.env.ZOHO_CAMPAIGNS_TOPIC_ID?.trim()
          ? { topicId: process.env.ZOHO_CAMPAIGNS_TOPIC_ID.trim() }
          : {}),
      },
      'ZohoCampaigns.campaign.CREATE',
    );
    const campaignKey = this.value(response, 'campaignKey', 'campaignkey');
    if (!campaignKey)
      throw new BadGatewayException(
        this.campaignCreateDiagnostic(response),
      );
    return campaignKey;
  }

  async sendCampaign(campaignKey: string) {
    return this.call(
      'sendcampaign',
      { resfmt: 'json', campaignkey: campaignKey },
      'ZohoCampaigns.campaign.UPDATE',
    );
  }

  async scheduleCampaign(campaignKey: string, scheduledAt: Date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.ZOHO_CAMPAIGNS_TIMEZONE || 'Africa/Lagos',
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(scheduledAt);
    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return this.call(
      'sendcampaign?isschedule=true',
      {
        resfmt: 'json',
        campaignkey: campaignKey,
        scheduledate: `${part('month')}/${part('day')}/${part('year')}`,
        schedulehour: part('hour'),
        scheduleminute: part('minute'),
        am_pm: part('dayPeriod'),
        istimewarp: 'false',
        sendingTZ: process.env.ZOHO_CAMPAIGNS_TIMEZONE || 'Africa/Lagos',
      },
      'ZohoCampaigns.campaign.UPDATE',
    );
  }

  async deleteCampaign(campaignKey: string) {
    return this.call(
      'deletecampaign',
      { resfmt: 'json', campaignkey: campaignKey },
      'ZohoCampaigns.campaign.DELETE',
      'GET',
    );
  }

  async testConnection() {
    // A read-only call verifies both the OAuth credentials and that the token
    // includes the campaign read scope. Never return the access token to callers.
    await this.call(
      'recentcampaigns',
      { resfmt: 'json', range: '1', status: 'all' },
      'ZohoCampaigns.campaign.READ',
      'GET',
    );
    return { connected: true, provider: 'Zoho Campaigns' };
  }

  private async call(
    path: string,
    params: Record<string, string>,
    requiredScope: string,
    method: 'GET' | 'POST' = 'POST',
  ) {
    const base = (
      process.env.ZOHO_CAMPAIGNS_API_URL ||
      'https://campaigns.zoho.com/api/v1.1'
    ).replace(/\/$/, '');
    const token = await this.accessToken();
    let response: Response;
    try {
      const query = new URLSearchParams(params);
      const [endpoint, queryString] = path.split('?');
      // Zoho Campaigns v1.1 documents POST parameters on the request URL.
      // Sending the same parameters in both URL and form body is rejected as
      // duplicate keys; sending them only in the body is silently ignored by
      // some Campaigns endpoints. Keep endpoint flags (for example
      // isschedule=true) and request parameters together in the query string.
      const requestUrl = `${base}/${endpoint}${queryString ? `?${queryString}&` : '?'}${query}`;
      response = await fetch(requestUrl, {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          Accept: 'application/json',
          ...(method === 'POST'
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new BadGatewayException(
          'Zoho Campaigns request timed out. Please retry.',
        );
      throw new BadGatewayException(
        'Could not connect to Zoho Campaigns. Please retry.',
      );
    }
    const raw = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';
    if (contentType.toLowerCase().includes('text/html')) {
      const providerMessage = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .slice(0, 500);
      const providerCode = providerMessage.match(/error code as\s+(\d+)/i)?.[1];
      throw new BadGatewayException(
        `Zoho Campaigns returned an HTML error page instead of an API response (HTTP ${response.status}${providerCode ? `, provider code ${providerCode}` : ''}). ${providerMessage || 'Check the Campaigns API domain and OAuth account/data-center configuration.'}`,
      );
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Some Campaigns v1.1 responses still use XML despite resfmt=JSON.
      // Parse known response fields so HTTP 200 provider errors are actionable.
      const xmlValue = (name: string) => {
        const match = raw.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
        return match?.[1]
          ?.replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&')
          .trim();
      };
      const code = xmlValue('code');
      const status = xmlValue('status');
      const message = xmlValue('message');
      const campaignKey = xmlValue('campaignKey') || xmlValue('campaignkey');
      payload = {
        ...(code ? { code } : {}),
        ...(status ? { status } : {}),
        ...(message ? { message } : {}),
        ...(campaignKey ? { campaignKey } : {}),
      };
    }
    const nested =
      payload.response && typeof payload.response === 'object'
        ? (payload.response as Record<string, unknown>)
        : payload;
    if (/createCampaign/i.test(path)) {
      const preview = raw
        .replace(/\s+/g, ' ')
        .replace(/(access_token|refresh_token|client_secret)\s*[=:]\s*[^,}\s]+/gi, '$1=[redacted]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .slice(0, 300);
      Object.defineProperty(nested, '__zohoResponse', {
        enumerable: false,
        value: {
          httpStatus: response.status,
          contentType: response.headers.get('content-type') || 'unknown',
          bodyLength: raw.length,
          preview,
        },
      });
    }
    const codeValue = nested.code;
    const code =
      typeof codeValue === 'string' || typeof codeValue === 'number'
        ? String(codeValue)
        : '';
    const status =
      typeof nested.status === 'string' ? nested.status.toLowerCase() : '';
    if (
      !response.ok ||
      (code && !['0', '200'].includes(code)) ||
      status === 'failure' ||
      status === 'error'
    ) {
      let message = typeof nested.message === 'string' && nested.message.trim()
        ? nested.message.trim()
        : code
          ? `Zoho Campaigns returned error code ${code} (HTTP ${response.status})`
          : response.status === 200 && /createCampaign/i.test(path)
            ? 'Zoho accepted the request but did not return a successful campaign response. Check the configured topic ID (required on accounts with updated topic management), sender approval, and campaign content URL.'
            : `Zoho Campaigns returned HTTP ${response.status}`;
      if (/invalid_scope/i.test(message)) {
        message = `The Zoho OAuth grant is missing ${requiredScope}. Re-authorize the Self Client with the required Campaigns scopes.`;
      }
      throw new BadGatewayException(`Zoho Campaigns: ${message}`);
    }
    return nested;
  }

  private async accessToken() {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000)
      return this.cachedToken;
    const clientId = process.env.ZOHO_CAMPAIGNS_CLIENT_ID?.trim();
    const clientSecret = process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET?.trim();
    const refreshToken = process.env.ZOHO_CAMPAIGNS_REFRESH_TOKEN?.trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new ServiceUnavailableException(
        'Zoho Campaigns OAuth is not configured. Add its client ID, client secret, and refresh token to the API environment.',
      );
    }
    const accountsUrl = (
      process.env.ZOHO_CAMPAIGNS_ACCOUNTS_URL || 'https://accounts.zoho.com'
    ).replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(`${accountsUrl}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BadGatewayException(
        'Could not refresh the Zoho Campaigns access token',
      );
    }
    const result = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !result.access_token) {
      if (result.error === 'invalid_code') {
        throw new ServiceUnavailableException(
          'Zoho rejected ZOHO_CAMPAIGNS_REFRESH_TOKEN. Set it to the refresh_token returned by the authorization-code exchange, not the generated code or access token. Also confirm the client credentials and Zoho Accounts URL belong to the same data center.',
        );
      }
      throw new ServiceUnavailableException(
        `Zoho Campaigns OAuth token refresh failed${result.error ? `: ${result.error}` : ''}`,
      );
    }
    this.cachedToken = result.access_token;
    this.tokenExpiresAt =
      Date.now() + (Number(result.expires_in) || 3600) * 1000;
    return this.cachedToken;
  }

  private value(payload: Record<string, unknown>, ...keys: string[]) {
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const find = (value: unknown, seen: Set<object>): string => {
      if (!value || typeof value !== 'object' || seen.has(value)) return '';
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (
          wanted.has(key.toLowerCase()) &&
          (typeof child === 'string' || typeof child === 'number') &&
          String(child).trim()
        )
          return String(child).trim();
      }
      for (const child of Object.values(value)) {
        const match = find(child, seen);
        if (match) return match;
      }
      return '';
    };
    return find(payload, new Set());
  }

  private campaignCreateDiagnostic(payload: Record<string, unknown>) {
    const findText = (value: unknown, keys: Set<string>, seen = new Set<object>()): string => {
      if (!value || typeof value !== 'object' || seen.has(value)) return '';
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (keys.has(key.toLowerCase()) && (typeof child === 'string' || typeof child === 'number'))
          return String(child).trim();
      }
      for (const child of Object.values(value)) {
        const match = findText(child, keys, seen);
        if (match) return match;
      }
      return '';
    };
    const status = findText(payload, new Set(['status']));
    const code = findText(payload, new Set(['code']));
    const message = findText(
      payload,
      new Set(['message', 'error_message', 'errormessage', 'description', 'reason']),
    );
    const responseDetails = payload.__zohoResponse as
      | { httpStatus?: number; contentType?: string; bodyLength?: number; preview?: string }
      | undefined;
    const details = [
      status && `status: ${status}`,
      code && `code: ${code}`,
      message && `message: ${message}`,
      responseDetails &&
        `HTTP ${responseDetails.httpStatus}; content type: ${responseDetails.contentType}; response length: ${responseDetails.bodyLength}`,
      responseDetails?.preview && `response: ${responseDetails.preview}`,
    ].filter(Boolean);
    return [
      'Zoho Campaigns did not return a campaign key for the create request.',
      ...details,
      'Check that ZOHO_CAMPAIGNS_TOPIC_ID is set to a valid topic when updated topic management is enabled, the sender is approved, and the public campaign content URL is reachable.',
    ].join(' ');
  }
}

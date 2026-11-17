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
          resfmt: 'JSON',
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
              resfmt: 'JSON',
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
        resfmt: 'JSON',
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
        'Zoho Campaigns did not return a campaign key. Confirm that ZOHO_CAMPAIGNS_TOPIC_ID is set to a topic in this account if topic management is enabled, and that the public campaign content URL is reachable.',
      );
    return campaignKey;
  }

  async sendCampaign(campaignKey: string) {
    return this.call(
      'sendcampaign',
      { resfmt: 'JSON', campaignkey: campaignKey },
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
        resfmt: 'JSON',
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
      { resfmt: 'JSON', campaignkey: campaignKey },
      'ZohoCampaigns.campaign.DELETE',
      'GET',
    );
  }

  async testConnection() {
    // A read-only call verifies both the OAuth credentials and that the token
    // includes the campaign read scope. Never return the access token to callers.
    await this.call(
      'recentcampaigns',
      { resfmt: 'JSON', range: '1', status: 'all' },
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
    for (const key of keys) {
      if (typeof payload[key] === 'string') return payload[key] as string;
    }
    return '';
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  audienceMembers,
  audiences,
  campaignDeliveries,
  campaigns,
  contacts,
} from '../database/schema.js';
import { MailService } from '../contacts/mail.service.js';
import { ZohoCampaignsService } from './zoho-campaigns.service.js';
import { TermiiService } from './termii.service.js';
import { ZohoWhatsAppService } from './zoho-whatsapp.service.js';

type CampaignStatus =
  | 'Draft'
  | 'Pending approval'
  | 'Approved'
  | 'Scheduled'
  | 'Paused'
  | 'Sending'
  | 'Sent'
  | 'Sent with failures'
  | 'Failed'
  | 'Cancelled';

@Injectable()
export class CampaignsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mail: MailService,
    private readonly zoho: ZohoCampaignsService,
    private readonly termii: TermiiService,
    private readonly zohoWhatsApp: ZohoWhatsAppService,
  ) {}

  async list() {
    return this.database.db
      .select()
      .from(campaigns)
      .orderBy(desc(campaigns.createdAt));
  }

  smsProviderStatus() {
    return {
      configured: Boolean(
        process.env.TERMII_API_KEY?.trim() &&
          process.env.TERMII_SENDER_ID?.trim(),
      ),
      senderId: process.env.TERMII_SENDER_ID?.trim() || null,
      countryCode: (process.env.TERMII_COUNTRY_CODE || '234').replace(/\D/g, ''),
      channel: process.env.TERMII_CHANNEL?.trim() || 'generic',
    };
  }

  testTermiiConnection() {
    return this.termii.testConnection();
  }

  whatsappProviderStatus() {
    return {
      configured: this.zohoWhatsApp.configured(),
      sender: process.env.ZOHO_WHATSAPP_FROM?.trim() || null,
    };
  }

  testZohoConnection() {
    return this.zoho.testConnection();
  }

  async create(input: Record<string, unknown>) {
    const campaign = this.validate(input);
    const existing = await this.database.db.select({ name: campaigns.name }).from(campaigns);
    if (existing.some((row) => row.name.toLocaleLowerCase() === campaign.name.toLocaleLowerCase()))
      throw new ConflictException('A campaign with this name already exists');
    const [row] = await this.database.db
      .insert(campaigns)
      .values({ ...campaign, status: 'Draft' })
      .returning();
    if (!row.scheduledAt) return row;
    try {
      const scheduled = await this.scheduleWithZoho(row);
      return scheduled;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Zoho Campaigns could not schedule this campaign';
      const [draft] = await this.database.db
        .update(campaigns)
        .set({ status: 'Draft', lastError: message, updatedAt: new Date() })
        .where(eq(campaigns.id, row.id))
        .returning();
      return { ...draft, scheduleError: message };
    }
  }

  async update(id: string, input: Record<string, unknown>) {
    const current = await this.get(id);
    if (current.status !== 'Draft')
      throw new ConflictException('Only draft email campaigns can be edited');
    const values = this.validate(input);
    if (values.name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      const names = await this.database.db
        .select({ id: campaigns.id, name: campaigns.name })
        .from(campaigns);
      if (
        names.some(
          (row) =>
            row.id !== id &&
            row.name.toLocaleLowerCase() === values.name.toLocaleLowerCase(),
        )
      ) {
        throw new ConflictException('A campaign with this name already exists');
      }
    }
    const [row] = await this.database.db
      .update(campaigns)
      .set({
        ...values,
        status: 'Draft',
        zohoCampaignKey: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, id))
      .returning();
    return row;
  }

  async requestApproval(id: string) {
    return this.updateStatus(id, ['Draft'], 'Pending approval');
  }

  async approve(id: string) {
    return this.updateStatus(id, ['Pending approval'], 'Approved');
  }

  async cancel(id: string) {
    const current = await this.get(id);
    if (!['Scheduled', 'Paused'].includes(current.status))
      throw new ConflictException(
        `Campaign cannot be cancelled while it is ${current.status}`,
      );
    if (current.zohoCampaignKey)
      await this.zoho.deleteCampaign(current.zohoCampaignKey);
    const [row] = await this.database.db
      .update(campaigns)
      .set({
        status: 'Cancelled',
        zohoCampaignKey: null,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, id))
      .returning();
    return row;
  }

  async pause(id: string, paused: boolean) {
    const current = await this.get(id);
    if (paused) {
      if (current.status !== 'Scheduled')
        throw new ConflictException(
          `Campaign cannot be paused while it is ${current.status}`,
        );
      if (current.zohoCampaignKey)
        await this.zoho.deleteCampaign(current.zohoCampaignKey);
      const [row] = await this.database.db
        .update(campaigns)
        .set({ status: 'Paused', zohoCampaignKey: null, updatedAt: new Date() })
        .where(eq(campaigns.id, id))
        .returning();
      return row;
    }
    if (current.status !== 'Paused')
      throw new ConflictException(
        `Campaign cannot be resumed while it is ${current.status}`,
      );
    return this.scheduleWithZoho(current);
  }

  async schedule(id: string) {
    const current = await this.get(id);
    if (current.channel !== 'Email')
      throw new BadRequestException(
        'Only email campaign scheduling is enabled. Send this campaign now or save it as a draft.',
      );
    if (current.status !== 'Draft')
      throw new ConflictException(
        `Campaign cannot be scheduled while it is ${current.status}`,
      );
    return this.scheduleWithZoho(current);
  }

  async sendNow(id: string) {
    const campaign = await this.get(id);
    if (campaign.channel === 'SMS') return this.sendSms(id);
    if (campaign.channel === 'WhatsApp') return this.sendWhatsApp(id);
    if (campaign.channel !== 'Email') throw new BadRequestException('Unsupported campaign channel');
    return this.dispatch(id, [
      'Draft',
      'Approved',
      'Failed',
      'Sent with failures',
    ]);
  }

  private async sendWhatsApp(id: string) {
    const [campaign] = await this.database.db
      .update(campaigns)
      .set({ status: 'Sending', lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          inArray(campaigns.status, ['Draft', 'Approved', 'Failed', 'Sent', 'Sent with failures']),
        ),
      )
      .returning();
    if (!campaign) {
      const current = await this.get(id);
      throw new ConflictException(
        `WhatsApp campaign cannot be sent while it is ${current.status}`,
      );
    }

    const sender = campaign.whatsappSender || process.env.ZOHO_WHATSAPP_FROM?.trim() || '';
    if (!/^\+\d{8,19}$/.test(sender)) {
      await this.markCampaignFailed(id, 'Set a WhatsApp sender number in international format.');
      throw new BadRequestException(
        'Set a WhatsApp sender number in international format (for example +2348012345678).',
      );
    }
    const template = campaign.whatsappTemplate?.trim();
    if (!template) {
      await this.markCampaignFailed(id, 'Select an approved Zoho CPaaS WhatsApp template.');
      throw new BadRequestException('Select an approved Zoho CPaaS WhatsApp template.');
    }
    let mergeInfo: Record<string, string>;
    try {
      mergeInfo = JSON.parse(campaign.whatsappMergeInfo || '{}') as Record<string, string>;
      if (!mergeInfo || Array.isArray(mergeInfo) || typeof mergeInfo !== 'object' ||
          Object.values(mergeInfo).some((value) => typeof value !== 'string'))
        throw new Error('invalid');
    } catch {
      await this.markCampaignFailed(id, 'WhatsApp template variable mapping is invalid.');
      throw new BadRequestException('WhatsApp template variable mapping must be a JSON object of strings.');
    }

    try {
      const recipients = await this.resolveRecipients(
        campaign.includedAudiences,
        campaign.excludedAudiences,
        campaign.excludedContacts,
        'WhatsApp',
      );
      if (!recipients.length)
        throw new BadRequestException(
          'No WhatsApp-opted-in contacts match the selected audiences and exclusions.',
        );
      const previous = await this.database.db
        .select()
        .from(campaignDeliveries)
        .where(eq(campaignDeliveries.campaignId, id));
      const deliveryByContact = new Map(previous.map((item) => [item.contactId, item]));
      const acceptedStatuses = ['queued', 'sent', 'delivered', 'read'];
      const acceptedIds = new Set(previous
        .filter((item) => acceptedStatuses.includes(item.status))
        .map((item) => item.contactId));
      const seenPhones = new Set(recipients
        .filter((contact) => acceptedIds.has(contact.id))
        .map((contact) => this.normalizeWhatsAppPhone(contact.phone))
        .filter((phone): phone is string => Boolean(phone)));
      const sendable: { contact: (typeof recipients)[number]; phone: string }[] = [];
      let invalidPhones = 0;
      let duplicatePhones = 0;
      let accepted = 0;
      for (const contact of recipients) {
        const prior = deliveryByContact.get(contact.id);
        if (prior && acceptedStatuses.includes(prior.status)) {
          accepted++;
          continue;
        }
        const phone = this.normalizeWhatsAppPhone(contact.phone);
        if (!phone) {
          invalidPhones++;
          await this.saveCampaignDelivery(id, contact.id, null, 'failed', 'Missing or invalid phone number');
        } else if (seenPhones.has(phone)) {
          duplicatePhones++;
          await this.saveCampaignDelivery(id, contact.id, null, 'duplicate', 'Same phone number is already included once');
        } else {
          seenPhones.add(phone);
          sendable.push({ contact, phone });
        }
      }
      let failed = invalidPhones;
      const errors: string[] = [];
      if (invalidPhones) errors.push(`${invalidPhones} contact(s) have missing or invalid phone numbers.`);
      if (duplicatePhones) errors.push(`${duplicatePhones} duplicate phone number(s) were sent once.`);
      for (let start = 0; start < sendable.length; start += 10) {
        const batch = sendable.slice(start, start + 10);
        const outcomes = await Promise.all(batch.map(async (contact) => {
          const prior = deliveryByContact.get(contact.contact.id);
          if (prior && ['queued', 'sent', 'delivered', 'read'].includes(prior.status))
            return { accepted: true as const };
          try {
            const resolvedMergeInfo = Object.fromEntries(
              Object.entries(mergeInfo).map(([key, value]) => [
                key,
                this.resolveWhatsAppVariable(value, contact.contact),
              ]),
            );
            const response = await this.zohoWhatsApp.send({
              from: sender,
              to: contact.phone,
              template,
              mergeInfo: resolvedMergeInfo,
              clientReference: `crm-${id}-${contact.contact.id}`.slice(0, 100),
            });
            await this.saveCampaignDelivery(id, contact.contact.id, response.message_id!, 'queued', null);
            deliveryByContact.set(contact.contact.id, {
              id: '', campaignId: id, contactId: contact.contact.id,
              providerMessageId: response.message_id!, status: 'queued', error: null,
              createdAt: new Date(), updatedAt: new Date(),
            });
            return { accepted: true as const };
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'Zoho CPaaS rejected the WhatsApp message';
            await this.saveCampaignDelivery(id, contact.contact.id, null, 'failed', detail);
            return { accepted: false as const, detail, email: contact.contact.email };
          }
        }));
        for (const outcome of outcomes) {
          if (outcome.accepted) accepted++;
          else {
            failed++;
            errors.push(`${outcome.email}: ${outcome.detail}`);
          }
        }
      }
      const status: CampaignStatus = failed
        ? accepted
          ? 'Sent with failures'
          : 'Failed'
        : 'Sent';
      const lastError = failed ? errors.join(' ').slice(0, 1000) : null;
      const [updated] = await this.database.db
        .update(campaigns)
        .set({
          status,
          recipientCount: recipients.length,
          deliveredCount: accepted,
          failedCount: failed,
          lastError,
          sentAt: accepted ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, id))
        .returning();
      return {
        ...updated,
        delivery: { total: recipients.length, sent: accepted, failed, errors },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'WhatsApp campaign delivery failed';
      await this.markCampaignFailed(id, detail);
      throw error;
    }
  }

  async refreshWhatsAppDelivery(id: string) {
    const campaign = await this.get(id);
    if (campaign.channel !== 'WhatsApp')
      throw new BadRequestException('Delivery refresh is only available for WhatsApp campaigns.');
    const rows = await this.database.db
      .select()
      .from(campaignDeliveries)
      .where(eq(campaignDeliveries.campaignId, id));
    const errors: string[] = [];
    for (const row of rows) {
      if (!row.providerMessageId || !['queued', 'sent'].includes(row.status)) continue;
      try {
        const response = await this.zohoWhatsApp.getMessage(row.providerMessageId);
        const status = response.data?.status;
        if (status && ['queued', 'sent', 'delivered', 'read', 'undelivered', 'failed', 'process_failed'].includes(status)) {
          let deliveryError = response.data?.error_message?.error?.message ?? null;
          if (!deliveryError && response.data?.error_msg) {
            try {
              const envelope = JSON.parse(response.data.error_msg) as { error?: { message?: string } };
              deliveryError = envelope.error?.message ?? null;
            } catch { /* preserve the provider status even if its optional error text is malformed */ }
          }
          await this.database.db
            .update(campaignDeliveries)
            .set({ status, error: deliveryError, updatedAt: new Date() })
            .where(eq(campaignDeliveries.id, row.id));
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Could not refresh a delivery status');
      }
    }
    const current = await this.database.db
      .select()
      .from(campaignDeliveries)
      .where(eq(campaignDeliveries.campaignId, id));
    const delivered = current.filter((item) => ['delivered', 'read'].includes(item.status)).length;
    const failed = current.filter((item) => ['undelivered', 'failed', 'process_failed'].includes(item.status)).length;
    const pending = current.filter((item) => ['queued', 'sent'].includes(item.status)).length;
    const deliveryStatus: CampaignStatus = failed
      ? delivered || pending
        ? 'Sent with failures'
        : 'Failed'
      : 'Sent';
    const lastError = current
      .filter((item) => ['undelivered', 'failed', 'process_failed'].includes(item.status))
      .map((item) => item.error)
      .filter((error): error is string => Boolean(error))
      .join(' ')
      .slice(0, 1000) || null;
    const [updated] = await this.database.db
      .update(campaigns)
      .set({ status: deliveryStatus, deliveredCount: delivered, failedCount: failed, lastError, updatedAt: new Date() })
      .where(eq(campaigns.id, id))
      .returning({ status: campaigns.status });
    return { total: current.length, delivered, failed, pending, errors, status: updated.status, lastError };
  }

  private async saveCampaignDelivery(
    campaignId: string,
    contactId: string,
    providerMessageId: string | null,
    status: string,
    error: string | null,
  ) {
    await this.database.db
      .insert(campaignDeliveries)
      .values({ campaignId, contactId, providerMessageId, status, error })
      .onConflictDoUpdate({
        target: [campaignDeliveries.campaignId, campaignDeliveries.contactId],
        set: { providerMessageId, status, error, updatedAt: new Date() },
      });
  }

  private normalizeWhatsAppPhone(phone: string | null) {
    if (!phone) return null;
    const trimmed = phone.trim();
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return null;
    const countryCode = (process.env.ZOHO_WHATSAPP_COUNTRY_CODE || '234').replace(/\D/g, '');
    const international = trimmed.startsWith('+')
      ? digits
      : digits.startsWith(countryCode)
        ? digits
        : `${countryCode}${digits.replace(/^0+/, '')}`;
    return /^\d{8,19}$/.test(international) ? `+${international}` : null;
  }

  private resolveWhatsAppVariable(value: string, contact: typeof contacts.$inferSelect) {
    const fields: Record<string, string> = {
      first_name: contact.firstName,
      last_name: contact.lastName || '',
      full_name: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
      email: contact.email,
      phone: contact.phone || '',
      organization: contact.organization || '',
    };
    return value.replace(/\{\{\s*(first_name|last_name|full_name|email|phone|organization)\s*\}\}/gi,
      (_match, field: string) => fields[field.toLowerCase()] ?? '');
  }

  private async sendSms(id: string) {
    const [campaign] = await this.database.db
      .update(campaigns)
      .set({ status: 'Sending', lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          inArray(campaigns.status, [
            'Draft',
            'Approved',
            'Failed',
            'Sent with failures',
          ]),
        ),
      )
      .returning();
    if (!campaign) {
      const current = await this.get(id);
      throw new ConflictException(
        `SMS campaign cannot be sent while it is ${current.status}`,
      );
    }

    const senderId = campaign.subject || process.env.TERMII_SENDER_ID?.trim() || '';
    if (!/^[A-Za-z0-9]{3,11}$/.test(senderId)) {
      await this.markCampaignFailed(id, 'Enter an approved 3 to 11 character sender ID.');
      throw new BadRequestException(
        'Enter an approved 3 to 11 character sender ID before sending.',
      );
    }
    let message = '';
    try {
      const blocks = JSON.parse(campaign.blocks) as { type: string; content?: string }[];
      message = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.content || '')
        .join('\n');
    } catch {
      await this.markCampaignFailed(id, 'SMS campaign content is invalid.');
      throw new BadRequestException('SMS campaign content is invalid.');
    }
    if (!message.trim()) {
      await this.markCampaignFailed(id, 'SMS campaign message is empty.');
      throw new BadRequestException('SMS campaign message is empty.');
    }

    let accepted = 0;
    let failed = 0;
    const errors: string[] = [];
    try {
      const recipients = await this.resolveRecipients(
        campaign.includedAudiences,
        campaign.excludedAudiences,
        campaign.excludedContacts,
        'SMS',
      );
      const priorDeliveries = await this.database.db
        .select()
        .from(campaignDeliveries)
        .where(eq(campaignDeliveries.campaignId, id));
      const acceptedStatuses = ['queued', 'sent', 'delivered', 'read'];
      const acceptedContactIds = new Set(
        priorDeliveries
          .filter((delivery) => acceptedStatuses.includes(delivery.status))
          .map((delivery) => delivery.contactId),
      );
      const acceptedPhones = new Set(
        recipients
          .filter((contact) => acceptedContactIds.has(contact.id))
          .map((contact) => this.termii.normalizePhone(contact.phone))
          .filter((phone): phone is string => Boolean(phone)),
      );
      const phoneOwners = new Map<string, (typeof recipients)[number]>();
      const seenPhones = new Set(acceptedPhones);
      let invalidPhones = 0;
      let duplicatePhones = 0;
      for (const contact of recipients) {
        const phone = this.termii.normalizePhone(contact.phone);
        if (acceptedContactIds.has(contact.id)) {
          accepted++;
          continue;
        }
        if (!phone) {
          invalidPhones++;
          await this.saveCampaignDelivery(id, contact.id, null, 'failed', 'Missing or invalid phone number');
        } else if (seenPhones.has(phone)) {
          duplicatePhones++;
          await this.saveCampaignDelivery(id, contact.id, null, 'duplicate', 'Same phone number is already included once');
        } else {
          seenPhones.add(phone);
          phoneOwners.set(phone, contact);
        }
      }
      if (!recipients.length)
        throw new BadRequestException(
          'No SMS-subscribed contacts match the selected audiences and exclusions.',
        );

      const pending = [...phoneOwners.entries()];
      for (let index = 0; index < pending.length; index += 100) {
        const batch = pending.slice(index, index + 100);
        try {
          await this.termii.sendBulk(batch.map(([phone]) => phone), message, senderId);
          accepted += batch.length;
          await Promise.all(batch.map(([, contact]) =>
            this.saveCampaignDelivery(id, contact.id, null, 'sent', null),
          ));
        } catch (error) {
          failed += batch.length;
          const detail = error instanceof Error ? error.message : 'Termii could not send this SMS batch';
          errors.push(detail);
          await Promise.all(batch.map(([, contact]) =>
            this.saveCampaignDelivery(id, contact.id, null, 'failed', detail),
          ));
          const unattempted = pending.slice(index + batch.length);
          if (unattempted.length) {
            const notAttemptedDetail = `Not attempted because an earlier Termii batch failed: ${detail}`;
            failed += unattempted.length;
            errors.push(`${unattempted.length} additional recipient(s) were not attempted after the Termii error.`);
            await Promise.all(unattempted.map(([, contact]) =>
              this.saveCampaignDelivery(id, contact.id, null, 'failed', notAttemptedDetail),
            ));
          }
          break;
        }
      }
      if (invalidPhones) {
        failed += invalidPhones;
        errors.push(`${invalidPhones} subscribed contact(s) have missing or invalid phone numbers.`);
      }
      if (duplicatePhones) errors.push(`${duplicatePhones} duplicate phone number(s) were sent once.`);
      const status: CampaignStatus = failed
        ? accepted
          ? 'Sent with failures'
          : 'Failed'
        : 'Sent';
      const lastError = failed ? errors.join(' ').slice(0, 1000) : null;
      const [updated] = await this.database.db
        .update(campaigns)
        .set({
          status,
          recipientCount: recipients.length,
          deliveredCount: accepted,
          failedCount: failed,
          lastError,
          sentAt: accepted ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, id))
        .returning();
      return {
        ...updated,
        delivery: { total: recipients.length, sent: accepted, failed, errors },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'SMS campaign delivery failed';
      await this.markCampaignFailed(id, message);
      throw error;
    }
  }

  private async markCampaignFailed(id: string, message: string) {
    await this.database.db
      .update(campaigns)
      .set({ status: 'Failed', lastError: message.slice(0, 1000), updatedAt: new Date() })
      .where(eq(campaigns.id, id));
  }

  async content(id: string) {
    const campaign = await this.get(id);
    let blocks: { type: string; content?: string; url?: string }[] = [];
    try {
      blocks = JSON.parse(campaign.blocks) as typeof blocks;
    } catch {
      throw new BadRequestException('Campaign content is invalid');
    }
    const body = blocks
      .map((block) => {
        const content = typeof block.content === 'string' ? block.content : '';
        const safe = this.escapeHtml(content).replace(/\n/g, '<br>');
        switch (block.type) {
          case 'text':
            return `<p>${safe}</p>`;
          case 'divider':
            return '<hr>';
          case 'image':
            return /^https:\/\//i.test(content)
              ? `<p><img src="${this.escapeHtml(content)}" alt="" style="max-width:100%;height:auto"></p>`
              : '';
          case 'link':
          case 'button':
            return typeof block.url === 'string' &&
              /^https:\/\//i.test(block.url)
              ? `<p><a href="${this.escapeHtml(block.url)}">${safe || this.escapeHtml(block.url)}</a></p>`
              : safe
                ? `<p>${safe}</p>`
                : '';
          default:
            return '';
        }
      })
      .join('\n');
    const personalized = body
      .replace(/\{\{\s*first_name\s*\}\}/gi, '$[FNAME|Friend]$')
      .replace(/\{\{\s*last_name\s*\}\}/gi, '$[LNAME]$')
      .replace(/\{\{\s*(name|full_name)\s*\}\}/gi, '$[FNAME|Friend]$');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#25243a">${personalized}</body></html>`;
  }

  async sendTest(input: Record<string, unknown>) {
    return this.mail.sendCampaignTestEmail(
      input.to,
      input.subject,
      input.blocks,
    );
  }

  private async updateStatus(
    id: string,
    from: CampaignStatus[],
    to: CampaignStatus,
  ) {
    const [row] = await this.database.db
      .update(campaigns)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), inArray(campaigns.status, from)))
      .returning();
    if (!row) {
      const existing = await this.get(id);
      throw new ConflictException(
        `Campaign cannot move from ${existing.status} to ${to}`,
      );
    }
    return row;
  }

  private async get(id: string) {
    const [row] = await this.database.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Campaign not found');
    return row;
  }

  private async scheduleWithZoho(campaign: typeof campaigns.$inferSelect) {
    if (!campaign.scheduledAt || campaign.scheduledAt <= new Date())
      throw new BadRequestException(
        'Choose a future time to schedule this campaign',
      );
    const recipients = await this.resolveRecipients(
      campaign.includedAudiences,
      campaign.excludedAudiences,
      campaign.excludedContacts,
    );
    if (!recipients.length)
      throw new BadRequestException(
        'No subscribed contacts match the selected audiences and exclusions',
      );
    let listKey = campaign.zohoListKey;
    if (!listKey) {
      listKey = await this.zoho.createMailingList(
        campaign,
        recipients,
        undefined,
        async (createdKey) => {
          await this.database.db
            .update(campaigns)
            .set({ zohoListKey: createdKey, updatedAt: new Date() })
            .where(eq(campaigns.id, campaign.id));
        },
      );
    } else {
      await this.zoho.createMailingList(campaign, recipients, listKey);
    }
    let campaignKey = campaign.zohoCampaignKey;
    if (!campaignKey) {
      campaignKey = await this.zoho.createCampaign(campaign, listKey);
      await this.database.db
        .update(campaigns)
        .set({ zohoCampaignKey: campaignKey, updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id));
    }
    await this.zoho.scheduleCampaign(campaignKey, campaign.scheduledAt);
    const [scheduled] = await this.database.db
      .update(campaigns)
      .set({
        status: 'Scheduled',
        zohoListKey: listKey,
        zohoCampaignKey: campaignKey,
        recipientCount: recipients.length,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaign.id))
      .returning();
    return scheduled;
  }

  private async dispatch(id: string, allowedStatuses: CampaignStatus[]) {
    const [campaign] = await this.database.db
      .update(campaigns)
      .set({ status: 'Sending', lastError: null, updatedAt: new Date() })
      .where(
        and(eq(campaigns.id, id), inArray(campaigns.status, allowedStatuses)),
      )
      .returning();
    if (!campaign) {
      const current = await this.get(id);
      throw new ConflictException(
        `Campaign cannot be sent while it is ${current.status}`,
      );
    }
    try {
      const recipients = await this.resolveRecipients(
        campaign.includedAudiences,
        campaign.excludedAudiences,
        campaign.excludedContacts,
      );
      if (!recipients.length)
        throw new BadRequestException(
          'No subscribed contacts match the selected audiences and exclusions',
        );
      let listKey = campaign.zohoListKey;
      if (!listKey) {
        listKey = await this.zoho.createMailingList(
          campaign,
          recipients,
          undefined,
          async (createdKey) => {
            await this.database.db
              .update(campaigns)
              .set({ zohoListKey: createdKey, updatedAt: new Date() })
              .where(eq(campaigns.id, id));
          },
        );
      } else await this.zoho.createMailingList(campaign, recipients, listKey);
      let campaignKey = campaign.zohoCampaignKey;
      if (!campaignKey) {
        campaignKey = await this.zoho.createCampaign(campaign, listKey);
        await this.database.db
          .update(campaigns)
          .set({ zohoCampaignKey: campaignKey, updatedAt: new Date() })
          .where(eq(campaigns.id, id));
      }
      await this.zoho.sendCampaign(campaignKey);
      const status: CampaignStatus = 'Sent';
      const [updated] = await this.database.db
        .update(campaigns)
        .set({
          status,
          recipientCount: recipients.length,
          deliveredCount: 0,
          failedCount: 0,
          sentAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, id))
        .returning();
      return {
        ...updated,
        delivery: {
          total: recipients.length,
          sent: recipients.length,
          failed: 0,
          errors: [],
        },
      };
    } catch (error) {
      await this.database.db
        .update(campaigns)
        .set({
          status: 'Failed',
          lastError:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : 'Campaign delivery failed',
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, id));
      throw error;
    }
  }

  private async resolveRecipients(
    includedNames: string[],
    excludedNames: string[],
    excludedEmails: string[],
    channel: 'Email' | 'SMS' | 'WhatsApp' = 'Email',
  ) {
    if (!includedNames.length)
      throw new BadRequestException(
        'Select at least one audience before sending',
      );
    const allAudiences = await this.database.db.select().from(audiences);
    const byName = new Map(
      allAudiences.map((audience) => [
        audience.name.toLocaleLowerCase(),
        audience,
      ]),
    );
    const selected = includedNames.map((name) =>
      byName.get(name.toLocaleLowerCase()),
    );
    if (selected.some((audience) => !audience))
      throw new BadRequestException(
        'One or more selected audiences no longer exist. Edit the campaign and choose current audiences.',
      );
    const excluded = new Set(
      excludedEmails.map((email) => email.toLocaleLowerCase()),
    );
    const excludedAudienceIds = excludedNames
      .map((name) => byName.get(name.toLocaleLowerCase())?.id)
      .filter((id): id is string => Boolean(id));
    for (const audience of allAudiences.filter((item) =>
      excludedAudienceIds.includes(item.id),
    )) {
      for (const contact of await this.contactsForAudience(audience, channel))
        excluded.add(contact.email.toLocaleLowerCase());
    }
    const recipients = new Map<string, typeof contacts.$inferSelect>();
    for (const audience of selected as (typeof audiences.$inferSelect)[]) {
      for (const contact of await this.contactsForAudience(audience, channel)) {
        if (
          (channel === 'SMS'
            ? contact.smsConsent === 'Subscribed'
            : channel === 'WhatsApp'
              ? contact.whatsappConsent === 'Subscribed'
              : contact.emailConsent === 'Subscribed') &&
          !excluded.has(contact.email.toLocaleLowerCase())
        )
          recipients.set(contact.id, contact);
      }
    }
    return [...recipients.values()];
  }

  private async contactsForAudience(
    audience: typeof audiences.$inferSelect,
    channel: 'Email' | 'SMS' | 'WhatsApp' = 'Email',
  ) {
    if (audience.type !== 'dynamic') {
      const rows = await this.database.db
        .select({ contact: contacts })
        .from(audienceMembers)
        .innerJoin(contacts, eq(contacts.id, audienceMembers.contactId))
        .where(eq(audienceMembers.audienceId, audience.id));
      return rows.map((row) => row.contact);
    }
    let rules: { field: string; operator: string; value: string }[] = [];
    try {
      rules = JSON.parse(audience.rules) as typeof rules;
    } catch {
      return [];
    }
    const rows = await this.database.db.select().from(contacts);
    return rows.filter(
      (contact) =>
        rules.length > 0 &&
        rules.every((rule) => {
          const values =
            rule.field === 'Category'
              ? [contact.category]
              : rule.field === 'Location'
                ? [contact.location ?? '']
                : rule.field === 'Status' || rule.field === 'Consent status'
                  ? [channel === 'SMS'
                    ? contact.smsConsent
                    : channel === 'WhatsApp'
                      ? contact.whatsappConsent
                      : contact.emailConsent]
                  : rule.field === 'Interest'
                    ? contact.interests
                    : contact.tags;
          const matched = values.some((value) =>
            rule.operator === 'contains'
              ? value
                  .toLocaleLowerCase()
                  .includes(rule.value.toLocaleLowerCase())
              : value.toLocaleLowerCase() === rule.value.toLocaleLowerCase(),
          );
          return rule.operator === 'is not' ? !matched : matched;
        }),
    );
  }

  private validate(input: Record<string, unknown>) {
    const name = this.string(input.name, 'Campaign name', 120);
    if (input.channel != null && typeof input.channel !== 'string')
      throw new BadRequestException('Campaign channel must be Email, SMS, or WhatsApp.');
    if (typeof input.channel === 'string' && !['Email', 'SMS', 'WhatsApp'].includes(input.channel))
      throw new BadRequestException('Campaign channel must be Email, SMS, or WhatsApp.');
    const channel = input.channel === 'SMS' ? 'SMS' : input.channel === 'WhatsApp' ? 'WhatsApp' : 'Email';
    const subject = channel === 'SMS'
      ? (typeof input.subject === 'string' && input.subject.trim()) || process.env.TERMII_SENDER_ID?.trim() || ''
      : channel === 'WhatsApp'
        ? ''
        : this.string(input.subject, 'Email subject', 200);
    if (channel === 'Email' && /[\r\n]/.test(subject))
      throw new BadRequestException('Email subject must fit on a single line');
    if (
      !Array.isArray(input.blocks) ||
      (channel !== 'WhatsApp' && !input.blocks.length) ||
      input.blocks.length > 100
    )
      throw new BadRequestException(
        'Add between 1 and 100 campaign content blocks',
      );
    const blocks = input.blocks.map((value) => {
      if (!value || typeof value !== 'object')
        throw new BadRequestException('Email content blocks are invalid');
      const block = value as Record<string, unknown>;
      if (
        !['text', 'image', 'link', 'button', 'divider'].includes(
          String(block.type),
        )
      )
        throw new BadRequestException('Unsupported email content block');
      if (channel !== 'Email' && block.type !== 'text')
        throw new BadRequestException(`${channel} campaigns support text content only`);
      const content = typeof block.content === 'string' ? block.content : '';
      const url = typeof block.url === 'string' ? block.url : undefined;
      if (content.length > 10000 || (url && url.length > 2048))
        throw new BadRequestException('Email content block is too long');
      return {
        id: typeof block.id === 'string' ? block.id : '',
        type: block.type,
        content,
        ...(url ? { url } : {}),
      };
    });
    const includedAudiences = this.stringArray(
      input.includedAudiences,
      'includedAudiences',
    );
    const excludedAudiences = this.stringArray(
      input.excludedAudiences,
      'excludedAudiences',
    );
    const excludedContacts = this.stringArray(
      input.excludedContacts,
      'excludedContacts',
      5000,
    );
    if (input.scheduledAt != null && typeof input.scheduledAt !== 'string') {
      throw new BadRequestException('scheduledAt must be a date string');
    }
    const scheduledAt =
      typeof input.scheduledAt === 'string' && input.scheduledAt
        ? new Date(input.scheduledAt)
        : null;
    const status = scheduledAt ? 'Scheduled' : 'Draft';
    if (
      scheduledAt &&
      (!Number.isFinite(scheduledAt.getTime()) || scheduledAt <= new Date())
    )
      throw new BadRequestException('Scheduled time must be in the future');
    if (scheduledAt && !includedAudiences.length)
      throw new BadRequestException(
        'Select at least one audience before scheduling',
      );
    if (channel === 'SMS' && !/^[A-Za-z0-9]{3,11}$/.test(subject))
      throw new BadRequestException('SMS sender ID must be 3 to 11 letters or numbers.');
    const message = channel === 'SMS'
      ? blocks.filter((block) => block.type === 'text').map((block) => block.content).join('\n')
      : '';
    if (channel === 'SMS' && !message.trim())
      throw new BadRequestException('SMS message is required.');
    if (channel === 'SMS' && /\{\{\s*[^}]+\s*\}\}/.test(message))
      throw new BadRequestException(
        'Termii bulk sends use one shared message. Remove personalization merge fields.',
      );
    const whatsappTemplate =
      typeof input.whatsappTemplate === 'string' ? input.whatsappTemplate.trim() : '';
    const whatsappSender =
      typeof input.whatsappSender === 'string' ? input.whatsappSender.trim() : '';
    let whatsappMergeInfo = '{}';
    if (channel === 'WhatsApp') {
      if (!whatsappTemplate || whatsappTemplate.length > 100)
        throw new BadRequestException('Choose an approved Zoho CPaaS template key or alias.');
      if (!/^\+\d{8,19}$/.test(whatsappSender))
        throw new BadRequestException('WhatsApp sender number must use international format, such as +2348012345678.');
      const value = input.whatsappMergeInfo ?? {};
      if (!value || Array.isArray(value) || typeof value !== 'object' ||
          Object.values(value as Record<string, unknown>).some((item) => typeof item !== 'string'))
        throw new BadRequestException('WhatsApp template variables must be a JSON object of strings.');
      whatsappMergeInfo = JSON.stringify(value);
      if (typeof input.whatsappTemplateType === 'string' && input.whatsappTemplateType === 'Marketing')
        throw new BadRequestException('Zoho CPaaS WhatsApp supports Utility and Authentication templates, not Marketing templates.');
    }
    if (channel !== 'Email' && input.scheduledAt)
      throw new BadRequestException('Scheduling is not enabled for SMS or WhatsApp campaigns. Save the campaign as a draft.');
    return {
      name,
      channel,
      status,
      objective:
        typeof input.objective === 'string'
          ? input.objective.slice(0, 500)
          : '',
      subject,
      whatsappTemplate: channel === 'WhatsApp' ? whatsappTemplate : null,
      whatsappSender: channel === 'WhatsApp' ? whatsappSender : null,
      whatsappMergeInfo,
      blocks: JSON.stringify(blocks),
      includedAudiences,
      excludedAudiences,
      excludedContacts,
      attachmentNames: this.stringArray(input.attachments, 'attachments', 50),
      scheduledAt,
    };
  }

  private string(value: unknown, label: string, max: number) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${label} is required`);
    if (value.trim().length > max)
      throw new BadRequestException(`${label} cannot exceed ${max} characters`);
    return value.trim();
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

  private stringArray(value: unknown, field: string, max = 100) {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string' || item.length > 254)
    )
      throw new BadRequestException(`${field} must be a list of text values`);
    return [
      ...new Set(value.map((item: string) => item.trim()).filter(Boolean)),
    ].slice(0, max);
  }
}

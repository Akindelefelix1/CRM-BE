import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  audienceMembers,
  audiences,
  campaigns,
  contacts,
} from '../database/schema.js';
import { MailService } from '../contacts/mail.service.js';
import { ZohoCampaignsService } from './zoho-campaigns.service.js';

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
  ) {}

  async list() {
    return this.database.db
      .select()
      .from(campaigns)
      .orderBy(campaigns.createdAt);
  }

  async create(input: Record<string, unknown>) {
    const campaign = this.validate(input);
    const [existing] = await this.database.db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.name, campaign.name))
      .limit(1);
    if (existing)
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
    if (current.status !== 'Draft')
      throw new ConflictException(
        `Campaign cannot be scheduled while it is ${current.status}`,
      );
    return this.scheduleWithZoho(current);
  }

  async sendNow(id: string) {
    return this.dispatch(id, [
      'Draft',
      'Approved',
      'Failed',
      'Sent with failures',
    ]);
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
      for (const contact of await this.contactsForAudience(audience))
        excluded.add(contact.email.toLocaleLowerCase());
    }
    const recipients = new Map<string, typeof contacts.$inferSelect>();
    for (const audience of selected as (typeof audiences.$inferSelect)[]) {
      for (const contact of await this.contactsForAudience(audience)) {
        if (
          contact.emailConsent === 'Subscribed' &&
          !excluded.has(contact.email.toLocaleLowerCase())
        )
          recipients.set(contact.id, contact);
      }
    }
    return [...recipients.values()];
  }

  private async contactsForAudience(audience: typeof audiences.$inferSelect) {
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
                  ? [contact.emailConsent]
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
    const subject = this.string(input.subject, 'Email subject', 200);
    if (/[\r\n]/.test(subject))
      throw new BadRequestException('Email subject must fit on a single line');
    if (
      !Array.isArray(input.blocks) ||
      !input.blocks.length ||
      input.blocks.length > 100
    )
      throw new BadRequestException(
        'Add between 1 and 100 email content blocks',
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
    return {
      name,
      channel: 'Email',
      status,
      objective:
        typeof input.objective === 'string'
          ? input.objective.slice(0, 500)
          : '',
      subject,
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

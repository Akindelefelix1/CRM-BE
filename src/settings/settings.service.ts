import { BadRequestException, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { privacyRequests, workspaceSettings } from '../database/schema.js';

const TIMEZONES = new Set(['Africa/Lagos', 'UTC', 'Europe/London', 'America/New_York']);
const REQUEST_TYPES = new Set(['Access', 'Correction', 'Deletion']);

@Injectable()
export class SettingsService {
  constructor(private readonly database: DatabaseService) {}

  async get(ownerId: string) {
    const [saved] = await this.database.db.select().from(workspaceSettings)
      .where(eq(workspaceSettings.ownerId, ownerId)).limit(1);
    const privacy = await this.listPrivacyRequests(ownerId);
    return {
      workspace: saved ?? { ownerId, organizationName: 'Cephas People', timezone: 'Africa/Lagos', senderName: 'Cephas People' },
      integrations: {
        email: {
          provider: 'Zoho Campaigns',
          configured: Boolean(process.env.ZOHO_CAMPAIGNS_CLIENT_ID?.trim() && process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET?.trim() && process.env.ZOHO_CAMPAIGNS_REFRESH_TOKEN?.trim() && process.env.ZOHO_CAMPAIGNS_FROM_EMAIL?.trim() && (process.env.API_PUBLIC_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim())),
          sender: process.env.ZOHO_CAMPAIGNS_FROM_EMAIL?.trim() || null,
        },
        sms: {
          provider: 'Termii',
          configured: Boolean(process.env.TERMII_API_KEY?.trim()),
          sender: process.env.TERMII_SENDER_ID?.trim() || null,
        },
        whatsapp: {
          provider: 'Zoho CPaaS',
          configured: Boolean(process.env.ZOHO_WHATSAPP_API_KEY?.trim()),
          sender: process.env.ZOHO_WHATSAPP_FROM?.trim() || null,
        },
      },
      policies: {
        emailConsentRequiredForSend: true,
        smsConsentRequiredForSend: true,
        whatsappConsentRequiredForSend: true,
        importedContactsDefaultConsent: 'Pending',
        twoFactorManagedBy: 'Neon Auth',
      },
      privacyRequests: privacy,
    };
  }

  async update(ownerId: string, input: Record<string, unknown>) {
    const organizationName = this.validateName(input.organizationName, 'organizationName', 120);
    const senderName = this.validateName(input.senderName, 'senderName', 80);
    if (typeof input.timezone !== 'string' || !TIMEZONES.has(input.timezone)) {
      throw new BadRequestException('Choose a supported timezone');
    }
    const now = new Date();
    const [saved] = await this.database.db.insert(workspaceSettings).values({
      ownerId, organizationName, timezone: input.timezone, senderName, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: workspaceSettings.ownerId,
      set: { organizationName, timezone: input.timezone, senderName, updatedAt: now },
    }).returning();
    return saved;
  }

  listPrivacyRequests(ownerId: string) {
    return this.database.db.select().from(privacyRequests)
      .where(eq(privacyRequests.ownerId, ownerId))
      .orderBy(desc(privacyRequests.createdAt), desc(privacyRequests.id))
      .limit(100);
  }

  async createPrivacyRequest(ownerId: string, input: Record<string, unknown>) {
    if (typeof input.requestType !== 'string' || !REQUEST_TYPES.has(input.requestType)) {
      throw new BadRequestException('Choose Access, Correction, or Deletion');
    }
    if (typeof input.email !== 'string' || !/^\S+@\S+\.\S+$/.test(input.email.trim())) {
      throw new BadRequestException('Enter a valid contact email');
    }
    const [request] = await this.database.db.insert(privacyRequests).values({
      ownerId,
      requestType: input.requestType,
      email: input.email.trim().toLowerCase(),
    }).returning();
    return request;
  }

  private validateName(value: unknown, field: string, max: number) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required`);
    const name = value.trim();
    if (name.length > max) throw new BadRequestException(`${field} must be ${max} characters or fewer`);
    return name;
  }
}

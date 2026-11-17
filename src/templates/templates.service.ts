import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { templates } from '../database/schema.js';

const channels = ['Email', 'SMS', 'WhatsApp'] as const;

@Injectable()
export class TemplatesService {
  constructor(private readonly database: DatabaseService) {}

  async list() {
    const rows = await this.database.db.select().from(templates).orderBy(asc(templates.name));
    return rows.map((row) => ({
      ...row,
      emailBlocks: this.parseJson(row.emailBlocks, []),
      whatsappMergeInfo: this.parseJson(row.whatsappMergeInfo, {}),
    }));
  }

  async create(input: Record<string, unknown>) {
    const values = this.values(input);
    await this.assertUnique(values.name);
    const [row] = await this.database.db.insert(templates).values(values).returning();
    return this.serialize(row);
  }

  async update(id: string, input: Record<string, unknown>) {
    const current = await this.require(id);
    const values = this.values(input);
    if (values.name.toLowerCase() !== current.name.toLowerCase()) await this.assertUnique(values.name);
    const [row] = await this.database.db.update(templates)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(templates.id, id)).returning();
    return this.serialize(row);
  }

  async use(id: string) {
    const [row] = await this.database.db.update(templates)
      .set({ useCount: sql`${templates.useCount} + 1`, updatedAt: new Date() })
      .where(eq(templates.id, id)).returning({ id: templates.id, useCount: templates.useCount });
    if (!row) throw new NotFoundException('Template not found');
    return { id: row.id, useCount: row.useCount };
  }

  async remove(id: string) {
    await this.require(id);
    await this.database.db.delete(templates).where(eq(templates.id, id));
    return { deleted: true, id };
  }

  private async require(id: string) {
    const [row] = await this.database.db.select().from(templates).where(eq(templates.id, id)).limit(1);
    if (!row) throw new NotFoundException('Template not found');
    return row;
  }

  private async assertUnique(name: string) {
    const rows = await this.database.db.select({ name: templates.name }).from(templates);
    if (rows.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException('A template with this name already exists');
    }
  }

  private values(input: Record<string, unknown>) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('Template name is required');
    if (name.length > 100) throw new BadRequestException('Template names may not exceed 100 characters');
    const channel = typeof input.channel === 'string' ? input.channel : '';
    if (!channels.includes(channel as (typeof channels)[number])) throw new BadRequestException('Choose Email, SMS, or WhatsApp as the template channel');
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (channel === 'Email' && !subject) throw new BadRequestException('Email templates need a subject line');
    if (subject.length > 200) throw new BadRequestException('Email subjects may not exceed 200 characters');
    if (!body) throw new BadRequestException('Template message content is required');
    if (body.length > 10000) throw new BadRequestException('Template message content may not exceed 10,000 characters');
    const emailBlocks = Array.isArray(input.emailBlocks) ? input.emailBlocks : [];
    if (emailBlocks.length > 100 || emailBlocks.some((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return true;
      const candidate = block as Record<string, unknown>;
      return !['text', 'image', 'link', 'button', 'divider'].includes(String(candidate.type)) ||
        typeof candidate.content !== 'string' || candidate.content.length > 10000;
    })) throw new BadRequestException('Template email content blocks are invalid or too long');
    const attachments = Array.isArray(input.attachments)
      ? input.attachments.filter((item): item is string => typeof item === 'string')
      : [];
    if (attachments.length > 50 || attachments.some((attachment) => attachment.length > 255))
      throw new BadRequestException('Template attachments are invalid or exceed the 50 item limit');
    const mergeInfo = input.whatsappMergeInfo && typeof input.whatsappMergeInfo === 'object' && !Array.isArray(input.whatsappMergeInfo)
      ? input.whatsappMergeInfo
      : {};
    const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
    const whatsappTemplate = typeof input.whatsappTemplate === 'string' ? input.whatsappTemplate.trim() : '';
    const whatsappSender = typeof input.whatsappSender === 'string' ? input.whatsappSender.trim() : '';
    if (objective.length > 500) throw new BadRequestException('Template purpose may not exceed 500 characters');
    if (whatsappTemplate.length > 100) throw new BadRequestException('Zoho CPaaS template names may not exceed 100 characters');
    if (whatsappSender.length > 20) throw new BadRequestException('WhatsApp sender numbers may not exceed 20 characters');
    if (JSON.stringify(mergeInfo).length > 10000) throw new BadRequestException('WhatsApp variable mappings are too large');
    return {
      name, channel, subject, body,
      emailBlocks: JSON.stringify(emailBlocks),
      attachments,
      objective,
      whatsappTemplate: whatsappTemplate || null,
      whatsappSender: whatsappSender || null,
      whatsappMergeInfo: JSON.stringify(mergeInfo),
    };
  }

  private serialize(row: typeof templates.$inferSelect) {
    return {
      ...row,
      emailBlocks: this.parseJson(row.emailBlocks, []),
      whatsappMergeInfo: this.parseJson(row.whatsappMergeInfo, {}),
    };
  }

  private parseJson(value: string, fallback: unknown) {
    try { return JSON.parse(value) as unknown; } catch { return fallback; }
  }
}

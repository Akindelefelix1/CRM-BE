import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { audienceMembers, audiences, contacts } from '../database/schema.js';

type AudienceRule = {
  field: 'Category' | 'Location' | 'Status' | 'Consent status' | 'Interest' | 'Tag';
  operator: 'is' | 'is not' | 'contains';
  value: string;
};

@Injectable()
export class AudiencesService {
  constructor(private readonly database: DatabaseService) {}

  async list() {
    const audienceRows = await this.database.db
      .select()
      .from(audiences)
      .orderBy(desc(audiences.createdAt));
    const counts = await this.database.db
      .select({ audienceId: audienceMembers.audienceId, memberCount: count() })
      .from(audienceMembers)
      .groupBy(audienceMembers.audienceId);
    const countById = new Map(counts.map((row) => [row.audienceId, Number(row.memberCount)]));
    const dynamicContacts = audienceRows.some((row) => row.type === 'dynamic')
      ? await this.database.db.select().from(contacts)
      : [];

    return audienceRows.map((audience) => ({
      ...audience,
      rules: this.readRules(audience.rules),
      memberCount: audience.type === 'dynamic'
        ? dynamicContacts.filter((contact) => this.matchesRules(contact, this.readRules(audience.rules))).length
        : countById.get(audience.id) ?? 0,
    }));
  }

  async get(id: string) {
    const audience = await this.requireAudience(id);
    const rules = this.readRules(audience.rules);
    const members = audience.type === 'dynamic'
      ? (await this.database.db.select().from(contacts))
          .filter((contact) => this.matchesRules(contact, rules))
          .map((contact) => ({ contact, addedAt: null }))
      : await this.database.db
          .select({ contact: contacts, addedAt: audienceMembers.addedAt })
          .from(audienceMembers)
          .innerJoin(contacts, eq(contacts.id, audienceMembers.contactId))
          .where(eq(audienceMembers.audienceId, id));
    return { ...audience, rules, memberCount: members.length, members };
  }

  async create(input: Record<string, unknown>) {
    const name = this.readName(input.name);
    const description = this.readDescription(input.description);
    const type = this.readType(input.type);
    const rules = this.readRulesInput(input.rules, type);
    const contactIds = this.readContactIds(input.contactIds);
    if (type === 'dynamic' && contactIds.length) {
      throw new BadRequestException('Dynamic audiences use rules instead of saved member IDs');
    }
    await this.assertUniqueName(name);

    const [row] = await this.database.db.transaction(async (tx) => {
      if (contactIds.length) {
        const existing = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(inArray(contacts.id, contactIds));
        if (existing.length !== contactIds.length) {
          throw new NotFoundException('One or more contacts were not found');
        }
      }
      const [created] = await tx.insert(audiences).values({
        name,
        description,
        type,
        rules: JSON.stringify(rules),
      }).returning();
      if (contactIds.length) {
        await tx.insert(audienceMembers)
          .values(contactIds.map((contactId) => ({ audienceId: created.id, contactId })))
          .onConflictDoNothing();
      }
      return [created];
    });
    const memberCount = type === 'dynamic'
      ? (await this.database.db.select().from(contacts)).filter((contact) => this.matchesRules(contact, rules)).length
      : contactIds.length;
    return { ...row, rules, memberCount };
  }

  async update(id: string, input: Record<string, unknown>) {
    const current = await this.requireAudience(id);
    const patch: Partial<typeof audiences.$inferInsert> = { updatedAt: new Date() };
    if ('name' in input) {
      patch.name = this.readName(input.name);
      await this.assertUniqueName(patch.name, id);
    }
    if ('description' in input) patch.description = this.readDescription(input.description);
    if ('type' in input) patch.type = this.readType(input.type);
    if ('rules' in input) patch.rules = JSON.stringify(this.readRulesInput(input.rules, (patch.type ?? current.type) as 'static' | 'dynamic'));
    const nextType = patch.type ?? current.type;
    if (nextType === 'dynamic' && !('rules' in input)) {
      const existingRules = this.readRules(current.rules);
      if (!existingRules.length) throw new BadRequestException('Dynamic audiences need at least one rule');
    }
    const [updated] = await this.database.db.transaction(async (tx) => {
      if (nextType === 'dynamic') {
        await tx.delete(audienceMembers).where(eq(audienceMembers.audienceId, id));
      }
      return tx.update(audiences).set(patch).where(eq(audiences.id, id)).returning();
    });
    const rules = this.readRules(updated.rules);
    const memberCount = nextType === 'dynamic'
      ? (await this.database.db.select().from(contacts)).filter((contact) => this.matchesRules(contact, rules)).length
      : Number((await this.database.db.select({ value: count() }).from(audienceMembers).where(eq(audienceMembers.audienceId, id)))[0]?.value ?? 0);
    return { ...updated, rules, memberCount };
  }

  async remove(id: string) {
    await this.requireAudience(id);
    await this.database.db.delete(audiences).where(eq(audiences.id, id));
    return { deleted: true, id };
  }

  async addMembers(audienceId: string, input: unknown) {
    const audience = await this.requireAudience(audienceId);
    if (audience.type !== 'static') {
      throw new BadRequestException('Members can only be added to static audiences');
    }
    if (!Array.isArray(input)) throw new BadRequestException('contactIds must be an array of IDs');
    const contactIds = this.readContactIds(input);
    if (!contactIds.length) return { added: 0 };
    const existing = await this.database.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.id, contactIds));
    if (existing.length !== contactIds.length) {
      throw new NotFoundException('One or more contacts were not found');
    }
    const inserted = await this.database.db.insert(audienceMembers)
      .values(contactIds.map((contactId) => ({ audienceId, contactId })))
      .onConflictDoNothing()
      .returning({ contactId: audienceMembers.contactId });
    return { added: inserted.length };
  }

  async removeMember(audienceId: string, contactId: string) {
    const audience = await this.requireAudience(audienceId);
    if (audience.type !== 'static') {
      throw new BadRequestException('Members cannot be removed individually from a dynamic audience');
    }
    const removed = await this.database.db.delete(audienceMembers)
      .where(and(eq(audienceMembers.audienceId, audienceId), eq(audienceMembers.contactId, contactId)))
      .returning({ contactId: audienceMembers.contactId });
    if (!removed.length) throw new NotFoundException('Audience member not found');
    return { removed: true, contactId };
  }

  private async requireAudience(id: string) {
    const [row] = await this.database.db.select().from(audiences).where(eq(audiences.id, id)).limit(1);
    if (!row) throw new NotFoundException('Audience not found');
    return row;
  }

  private async assertUniqueName(name: string, exceptId?: string) {
    const rows = await this.database.db.select({ id: audiences.id, name: audiences.name }).from(audiences);
    if (rows.some((row) => row.id !== exceptId && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new ConflictException('An audience with this name already exists');
    }
  }

  private readName(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('name is required');
    const name = value.trim();
    if (name.length > 120) throw new BadRequestException('Audience names may not exceed 120 characters');
    return name;
  }

  private readDescription(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new BadRequestException('description must be a string');
    if (value.trim().length > 500) throw new BadRequestException('Descriptions may not exceed 500 characters');
    return value.trim() || null;
  }

  private readType(value: unknown): 'static' | 'dynamic' {
    if (value !== 'static' && value !== 'dynamic') throw new BadRequestException('type must be static or dynamic');
    return value;
  }

  private readContactIds(value: unknown) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('contactIds must be an array of IDs');
    }
    const ids = [...new Set(value as string[])];
    if (ids.length > 5000) throw new BadRequestException('An audience can accept up to 5,000 members per request');
    return ids;
  }

  private readRulesInput(value: unknown, type: 'static' | 'dynamic'): AudienceRule[] {
    if (value === undefined && type === 'static') return [];
    if (!Array.isArray(value)) throw new BadRequestException('rules must be an array');
    const allowedFields = ['Category', 'Location', 'Status', 'Consent status', 'Interest', 'Tag'];
    const allowedOperators = ['is', 'is not', 'contains'];
    const rules = value.map((rule) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new BadRequestException('Each audience rule must be an object');
      const candidate = rule as Record<string, unknown>;
      if (!allowedFields.includes(String(candidate.field))) throw new BadRequestException('Audience rule field is not supported');
      if (!allowedOperators.includes(String(candidate.operator))) throw new BadRequestException('Audience rule operator is not supported');
      if (typeof candidate.value !== 'string' || !candidate.value.trim() || candidate.value.length > 200) {
        throw new BadRequestException('Each audience rule needs a value of up to 200 characters');
      }
      return { field: candidate.field, operator: candidate.operator, value: candidate.value.trim() } as AudienceRule;
    });
    if (type === 'dynamic' && !rules.length) throw new BadRequestException('Dynamic audiences need at least one rule');
    if (rules.length > 20) throw new BadRequestException('Audiences can have up to 20 rules');
    return rules;
  }

  private readRules(value: string): AudienceRule[] {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? this.readRulesInput(parsed, 'static') : [];
    } catch {
      return [];
    }
  }

  private matchesRules(contact: typeof contacts.$inferSelect, rules: AudienceRule[]) {
    if (!rules.length) return false;
    return rules.every((rule) => {
      const values = rule.field === 'Category'
        ? [contact.category]
        : rule.field === 'Location'
          ? [contact.location ?? '']
          : rule.field === 'Status' || rule.field === 'Consent status'
            ? [contact.emailConsent]
            : rule.field === 'Interest'
              ? contact.interests
              : contact.tags;
      const matched = values.some((value) => rule.operator === 'contains'
        ? value.toLocaleLowerCase().includes(rule.value.toLocaleLowerCase())
        : value.toLocaleLowerCase() === rule.value.toLocaleLowerCase());
      return rule.operator === 'is not' ? !matched : matched;
    });
  }
}

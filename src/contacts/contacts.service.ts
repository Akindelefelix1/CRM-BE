import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { contactCategories, contacts } from '../database/schema.js';

@Injectable()
export class ContactsService {
  constructor(private readonly database: DatabaseService) {}

  list(search?: string) {
    const db = this.database.db;
    return search?.trim()
      ? db.select().from(contacts).where(or(
          ilike(contacts.firstName, `%${search}%`),
          ilike(contacts.lastName, `%${search}%`),
          ilike(contacts.email, `%${search}%`),
          ilike(contacts.organization, `%${search}%`),
          ilike(contacts.location, `%${search}%`),
        )).orderBy(desc(contacts.createdAt))
      : db.select().from(contacts).orderBy(desc(contacts.createdAt));
  }

  async get(id: string) {
    const [contact] = await this.database.db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  async create(input: Record<string, unknown>) {
    const values = this.normalize(input) as typeof contacts.$inferInsert;
    const [contact] = await this.database.db.transaction(async (tx) => {
      await this.ensureCategory(tx, values.category ?? 'Uncategorized');
      return tx.insert(contacts).values(values).returning();
    });
    return contact;
  }

  async createMany(input: unknown) {
    if (!Array.isArray(input)) throw new BadRequestException('contacts must be an array');
    if (input.length > 1000) throw new BadRequestException('Import is limited to 1,000 contacts at a time');
    if (!input.length) return { contacts: [], created: 0, skipped: 0 };

    const unique = new Map<string, typeof contacts.$inferInsert>();
    for (const row of input) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new BadRequestException('Each contact must be an object');
      const values = this.normalize(row as Record<string, unknown>) as typeof contacts.$inferInsert;
      if (!values.email || !values.firstName) throw new BadRequestException('Every contact needs a name and email');
      if (!unique.has(values.email)) unique.set(values.email, values);
    }

    const values = [...unique.values()];
    const created = await this.database.db.transaction(async (tx) => {
      for (const category of new Set(values.map((contact) => contact.category ?? 'Uncategorized'))) {
        await this.ensureCategory(tx, category);
      }
      return tx.insert(contacts).values(values).onConflictDoNothing({ target: contacts.email }).returning();
    });
    return { contacts: created, created: created.length, skipped: input.length - created.length };
  }

  async update(id: string, input: Record<string, unknown>) {
    await this.get(id);
    const values = this.normalize(input, true);
    if (typeof values.category === 'string') await this.ensureCategory(this.database.db, values.category);
    const [contact] = await this.database.db.update(contacts)
      .set({ ...values, updatedAt: new Date() }).where(eq(contacts.id, id)).returning();
    return contact;
  }

  async merge(id: string, input: Record<string, unknown>) {
    const sourceId = typeof input.sourceId === 'string' ? input.sourceId : undefined;
    const { sourceId: _sourceId, ...contactInput } = input;
    await this.get(id);
    if (sourceId && sourceId !== id) await this.get(sourceId);
    if (sourceId === id) throw new BadRequestException('A contact cannot be merged into itself');
    const values = this.normalize(contactInput, true);
    return this.database.db.transaction(async (tx) => {
      if (typeof values.category === 'string') await this.ensureCategory(tx, values.category);
      const [contact] = await tx.update(contacts).set({ ...values, updatedAt: new Date() })
        .where(eq(contacts.id, id)).returning();
      if (sourceId) await tx.delete(contacts).where(eq(contacts.id, sourceId));
      return contact;
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.database.db.delete(contacts).where(eq(contacts.id, id));
    return { deleted: true, id };
  }

  async removeMany(input: unknown) {
    if (!Array.isArray(input) || input.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('contactIds must be an array of IDs');
    }
    const ids = [...new Set(input as string[])];
    if (!ids.length) return { deleted: 0 };
    const rows = await this.database.db.delete(contacts).where(inArray(contacts.id, ids)).returning({ id: contacts.id });
    return { deleted: rows.length, ids: rows.map((row) => row.id) };
  }

  private async ensureCategory(db: DatabaseService['db'], name: string): Promise<void>;
  private async ensureCategory(db: Parameters<DatabaseService['db']['transaction']>[0] extends (tx: infer T) => unknown ? T : never, name: string): Promise<void>;
  private async ensureCategory(db: any, name: string) {
    const normalized = name.trim() || 'Uncategorized';
    await db.insert(contactCategories).values({ name: normalized }).onConflictDoNothing();
  }

  private normalize(input: Record<string, unknown>, partial = false): Partial<typeof contacts.$inferInsert> {
    const allowed = ['firstName', 'lastName', 'email', 'alternateEmails', 'phone', 'organization', 'category', 'location', 'interests', 'tags', 'emailConsent', 'smsConsent'] as const;
    const values: Record<string, unknown> = {};
    for (const key of allowed) if (key in input) values[key] = input[key];
    if (!partial || 'email' in values) {
      if (typeof values.email !== 'string' || !/^\S+@\S+\.\S+$/.test(values.email.trim())) {
        throw new BadRequestException('A valid email address is required');
      }
      values.email = values.email.trim().toLowerCase();
    }
    if (!partial || 'firstName' in values) {
      if (typeof values.firstName !== 'string' || !values.firstName.trim()) {
        throw new BadRequestException('firstName is required');
      }
      values.firstName = values.firstName.trim();
    }
    if ('lastName' in values) {
      if (values.lastName !== null && typeof values.lastName !== 'string') {
        throw new BadRequestException('lastName must be a string');
      }
      values.lastName = typeof values.lastName === 'string' ? values.lastName.trim() : '';
    }
    if ('category' in values) {
      if (values.category !== null && typeof values.category !== 'string') {
        throw new BadRequestException('category must be a string');
      }
      values.category = typeof values.category === 'string' ? values.category.trim() || 'Uncategorized' : 'Uncategorized';
    }
    for (const key of ['phone', 'organization', 'location'] as const) {
      if (!(key in values)) continue;
      if (values[key] !== null && typeof values[key] !== 'string') {
        throw new BadRequestException(`${key} must be a string or null`);
      }
      values[key] = typeof values[key] === 'string' ? values[key].trim() || null : null;
    }
    for (const key of ['alternateEmails', 'interests', 'tags'] as const) {
      if (!(key in values)) continue;
      if (!Array.isArray(values[key]) || values[key].some((value) => typeof value !== 'string')) {
        throw new BadRequestException(`${key} must be an array of strings`);
      }
      const cleaned = (values[key] as string[]).map((value) => value.trim()).filter(Boolean);
      values[key] = key === 'alternateEmails'
        ? [...new Set(cleaned.map((value) => value.toLowerCase()).filter((value) => value !== values.email))]
        : [...new Set(cleaned)];
      if (key === 'alternateEmails' && (values[key] as string[]).some((value) => !/^\S+@\S+\.\S+$/.test(value))) {
        throw new BadRequestException('alternateEmails must contain valid email addresses');
      }
    }
    for (const key of ['emailConsent', 'smsConsent'] as const) {
      if (!(key in values)) continue;
      if (!['Subscribed', 'Unsubscribed', 'Pending'].includes(String(values[key]))) {
        throw new BadRequestException(`${key} must be Subscribed, Unsubscribed, or Pending`);
      }
    }
    return values as Partial<typeof contacts.$inferInsert>;
  }
}

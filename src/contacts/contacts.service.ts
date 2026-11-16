import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ilike, or, eq, desc } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { contacts } from '../database/schema.js';

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
        )).orderBy(desc(contacts.createdAt))
      : db.select().from(contacts).orderBy(desc(contacts.createdAt));
  }

  async get(id: string) {
    const [contact] = await this.database.db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  async create(input: Record<string, unknown>) {
    const [contact] = await this.database.db.insert(contacts).values(this.normalize(input) as typeof contacts.$inferInsert).returning();
    return contact;
  }

  async update(id: string, input: Record<string, unknown>) {
    await this.get(id);
    const [contact] = await this.database.db.update(contacts)
      .set({ ...this.normalize(input, true), updatedAt: new Date() }).where(eq(contacts.id, id)).returning();
    return contact;
  }

  async remove(id: string) {
    await this.get(id);
    await this.database.db.delete(contacts).where(eq(contacts.id, id));
    return { deleted: true, id };
  }

  private normalize(input: Record<string, unknown>, partial = false): Partial<typeof contacts.$inferInsert> {
    const allowed = ['firstName', 'lastName', 'email', 'phone', 'organization', 'category', 'location', 'interests', 'tags', 'emailConsent', 'smsConsent'] as const;
    const values: Record<string, unknown> = {};
    for (const key of allowed) if (key in input) values[key] = input[key];
    if (!partial && (!values.firstName || !values.email)) throw new BadRequestException('firstName and email are required');
    return values as Partial<typeof contacts.$inferInsert>;
  }
}

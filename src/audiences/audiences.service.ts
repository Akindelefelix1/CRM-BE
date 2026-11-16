import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { audienceMembers, audiences, contacts } from '../database/schema.js';

@Injectable()
export class AudiencesService {
  constructor(private readonly database: DatabaseService) {}

  async list() {
    const rows = await this.database.db.select({ audience: audiences, memberCount: count(audienceMembers.contactId) })
      .from(audiences).leftJoin(audienceMembers, eq(audiences.id, audienceMembers.audienceId))
      .groupBy(audiences.id).orderBy(desc(audiences.createdAt));
    return rows.map(({ audience, memberCount }) => ({ ...audience, memberCount: Number(memberCount) }));
  }

  async get(id: string) {
    const [audience] = await this.database.db.select().from(audiences).where(eq(audiences.id, id)).limit(1);
    if (!audience) throw new NotFoundException('Audience not found');
    const members = await this.database.db.select({ contact: contacts, addedAt: audienceMembers.addedAt })
      .from(audienceMembers).innerJoin(contacts, eq(contacts.id, audienceMembers.contactId))
      .where(eq(audienceMembers.audienceId, id));
    return { ...audience, rules: JSON.parse(audience.rules), members };
  }

  async create(input: Record<string, unknown>) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new BadRequestException('name is required');
    const name = input.name.trim();
    const contactIds = Array.isArray(input.contactIds)
      ? [...new Set(input.contactIds.filter((id): id is string => typeof id === 'string'))]
      : [];
    return this.database.db.transaction(async (tx) => {
      if (contactIds.length) {
        const existing = await tx.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, contactIds));
        if (existing.length !== contactIds.length) throw new NotFoundException('One or more contacts were not found');
      }
      const [row] = await tx.insert(audiences).values({
        name,
        description: typeof input.description === 'string' ? input.description : null,
        type: input.type === 'dynamic' ? 'dynamic' : 'static',
        rules: JSON.stringify(Array.isArray(input.rules) ? input.rules : []),
      }).returning();
      if (contactIds.length) {
        await tx.insert(audienceMembers).values(contactIds.map((contactId) => ({ audienceId: row.id, contactId }))).onConflictDoNothing();
      }
      return { ...row, rules: JSON.parse(row.rules), memberCount: contactIds.length };
    });
  }

  async update(id: string, input: Record<string, unknown>) {
    await this.requireAudience(id);
    const patch: Partial<typeof audiences.$inferInsert> = { updatedAt: new Date() };
    if (typeof input.name === 'string') patch.name = input.name.trim();
    if (typeof input.description === 'string' || input.description === null) patch.description = input.description as string | null;
    if (input.type === 'static' || input.type === 'dynamic') patch.type = input.type;
    if (Array.isArray(input.rules)) patch.rules = JSON.stringify(input.rules);
    const [row] = await this.database.db.update(audiences).set(patch).where(eq(audiences.id, id)).returning();
    return { ...row, rules: JSON.parse(row.rules) };
  }

  async remove(id: string) {
    await this.requireAudience(id);
    await this.database.db.delete(audiences).where(eq(audiences.id, id));
    return { deleted: true, id };
  }

  async addMembers(audienceId: string, contactIds: string[]) {
    await this.requireAudience(audienceId);
    if (!Array.isArray(contactIds)) throw new BadRequestException('contactIds must be an array');
    const uniqueIds = [...new Set(contactIds)];
    if (!uniqueIds.length) return { added: 0 };
    const existing = await this.database.db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, uniqueIds));
    if (existing.length !== uniqueIds.length) throw new NotFoundException('One or more contacts were not found');
    await this.database.db.insert(audienceMembers).values(uniqueIds.map((contactId) => ({ audienceId, contactId }))).onConflictDoNothing();
    return { added: uniqueIds.length };
  }

  async removeMember(audienceId: string, contactId: string) {
    await this.database.db.delete(audienceMembers).where(and(eq(audienceMembers.audienceId, audienceId), eq(audienceMembers.contactId, contactId)));
    return { removed: true };
  }

  private async requireAudience(id: string) {
    const [row] = await this.database.db.select({ id: audiences.id }).from(audiences).where(eq(audiences.id, id)).limit(1);
    if (!row) throw new NotFoundException('Audience not found');
  }
}

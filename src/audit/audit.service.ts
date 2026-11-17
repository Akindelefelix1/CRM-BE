import { BadRequestException, Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { auditEvents } from '../database/schema.js';

export type CreateAuditEventInput = {
  actorName: string;
  actorEmail?: string;
  action: string;
  details?: string;
  eventType: string;
};

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async create(actorId: string, input: CreateAuditEventInput) {
    const actorName = this.requiredText(input.actorName, 'actorName', 120);
    const action = this.requiredText(input.action, 'action', 160);
    const eventType = this.requiredText(input.eventType, 'eventType', 100);
    if (input.details !== undefined && typeof input.details !== 'string') {
      throw new BadRequestException('details must be a string');
    }
    const details = typeof input.details === 'string' ? input.details.trim() : '';
    if (details.length > 2000) throw new BadRequestException('details must be 2000 characters or fewer');
    if (input.actorEmail !== undefined && typeof input.actorEmail !== 'string') {
      throw new BadRequestException('actorEmail must be a valid email address');
    }
    const actorEmail = typeof input.actorEmail === 'string' && input.actorEmail.trim() ? input.actorEmail.trim() : null;
    if (actorEmail && (actorEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actorEmail))) {
      throw new BadRequestException('actorEmail must be a valid email address');
    }
    const [event] = await this.database.db.insert(auditEvents).values({
      actorId, actorName, actorEmail, action, details, eventType,
    }).returning();
    return event;
  }

  async list(actorId: string, options: { search?: string; eventType?: string; limit?: number; offset?: number }) {
    const limit = Math.min(100, Math.max(1, Number.isInteger(options.limit) ? options.limit! : 25));
    const offset = Math.max(0, Number.isInteger(options.offset) ? options.offset! : 0);
    if (offset > 100_000) throw new BadRequestException('offset is outside the supported range');
    const search = options.search?.trim().slice(0, 200);
    const filters = [eq(auditEvents.actorId, actorId)];
    const eventType = options.eventType?.trim();
    if (eventType && eventType !== 'All activity') filters.push(eq(auditEvents.eventType, eventType.slice(0, 100)));
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      filters.push(or(
        ilike(auditEvents.actorName, pattern),
        ilike(auditEvents.actorEmail, pattern),
        ilike(auditEvents.action, pattern),
        ilike(auditEvents.details, pattern),
        ilike(auditEvents.eventType, pattern),
      )!);
    }
    const where = and(...filters);
    const [rows, [{ value: total }], types] = await Promise.all([
      this.database.db.select().from(auditEvents).where(where).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(limit).offset(offset),
      this.database.db.select({ value: count() }).from(auditEvents).where(where),
      this.database.db.selectDistinct({ eventType: auditEvents.eventType }).from(auditEvents).where(eq(auditEvents.actorId, actorId)).orderBy(auditEvents.eventType),
    ]);
    return { items: rows, total, eventTypes: types.map((row) => row.eventType), limit, offset };
  }

  private requiredText(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required`);
    const result = value.trim();
    if (result.length > maxLength) throw new BadRequestException(`${field} must be ${maxLength} characters or fewer`);
    return result;
  }
}

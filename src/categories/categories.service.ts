import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { audiences, contactCategories, contacts } from '../database/schema.js';

@Injectable()
export class CategoriesService {
  constructor(private readonly database: DatabaseService) {}

  list() {
    return this.database.db.select().from(contactCategories).orderBy(asc(contactCategories.name));
  }

  async create(input: Record<string, unknown>) {
    const name = this.nameFrom(input.name);
    await this.assertUnique(name);
    const [category] = await this.database.db.insert(contactCategories).values({ name }).returning();
    return category;
  }

  async rename(previousName: string, input: Record<string, unknown>) {
    const name = this.nameFrom(input.name);
    const current = await this.require(previousName);
    if (current.name.toLowerCase() !== name.toLowerCase()) await this.assertUnique(name);
    return this.database.db.transaction(async (tx) => {
      const [category] = await tx.update(contactCategories)
        .set({ name, updatedAt: new Date() })
        .where(eq(contactCategories.id, current.id))
        .returning();
      await tx.update(contacts).set({ category: name, updatedAt: new Date() })
        .where(eq(contacts.category, current.name));
      await this.updateAudienceRules(tx, current.name, name);
      return category;
    });
  }

  async remove(name: string, input: Record<string, unknown>) {
    const current = await this.require(name);
    const fallbackName = typeof input.fallbackName === 'string' ? input.fallbackName.trim() : '';
    if (!fallbackName || fallbackName.toLowerCase() === current.name.toLowerCase()) {
      throw new BadRequestException('A different fallback category is required');
    }
    const fallback = await this.require(fallbackName);
    return this.database.db.transaction(async (tx) => {
      const moved = await tx.update(contacts).set({ category: fallback.name, updatedAt: new Date() })
        .where(eq(contacts.category, current.name)).returning({ id: contacts.id });
      await tx.delete(contactCategories).where(eq(contactCategories.id, current.id));
      await this.updateAudienceRules(tx, current.name, fallback.name);
      return { deleted: true, name: current.name, movedContacts: moved.length, fallback: fallback.name };
    });
  }

  private async require(name: string) {
    const [category] = await this.database.db.select().from(contactCategories)
      .where(eq(contactCategories.name, name)).limit(1);
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  private async assertUnique(name: string) {
    const categories = await this.list();
    if (categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException('A category with this name already exists');
    }
  }

  private nameFrom(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('name is required');
    if (value.trim().length > 48) throw new BadRequestException('Category names may not exceed 48 characters');
    return value.trim();
  }

  private async updateAudienceRules(tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0], from: string, to: string) {
    const rows = await tx.select({ id: audiences.id, rules: audiences.rules }).from(audiences);
    for (const row of rows) {
      try {
        const rules: unknown = JSON.parse(row.rules);
        if (!Array.isArray(rules)) continue;
        let changed = false;
        const updated = rules.map((rule) => {
          if (rule && typeof rule === 'object' && 'field' in rule && 'value' in rule &&
            rule.field === 'Category' && rule.value === from) {
            changed = true;
            return { ...rule, value: to };
          }
          return rule;
        });
        if (changed) await tx.update(audiences).set({ rules: JSON.stringify(updated), updatedAt: new Date() })
          .where(eq(audiences.id, row.id));
      } catch {
        // Leave malformed legacy rules intact; updating the category itself must still complete.
      }
    }
  }
}

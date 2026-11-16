import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { Sql } from 'postgres';
import * as schema from './schema.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private client?: Sql;
  private database?: PostgresJsDatabase<typeof schema>;

  get db(): PostgresJsDatabase<typeof schema> {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    if (!this.database) {
      this.client = postgres(process.env.DATABASE_URL, {
        max: Number(process.env.DATABASE_POOL_SIZE ?? 5),
        idle_timeout: 20,
        connect_timeout: 10,
        ssl: 'require',
      });
      this.database = drizzle(this.client, { schema });
    }
    return this.database;
  }

  async onModuleDestroy() {
    await this.client?.end({ timeout: 5 });
  }
}

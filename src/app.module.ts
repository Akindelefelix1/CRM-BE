import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { DatabaseModule } from './database/database.module.js';
import { ContactsModule } from './contacts/contacts.module.js';
import { AudiencesModule } from './audiences/audiences.module.js';
import { FilesModule } from './files/files.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { NeonAuthGuard } from './auth/neon-auth.guard.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { AuditModule } from './audit/audit.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '.env.local'] }),
    DatabaseModule,
    ContactsModule,
    AudiencesModule,
    FilesModule,
    CategoriesModule,
    CampaignsModule,
    TemplatesModule,
    AnalyticsModule,
    AuditModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: NeonAuthGuard }],
})
export class AppModule {}

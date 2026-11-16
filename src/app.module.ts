import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { DatabaseModule } from './database/database.module.js';
import { ContactsModule } from './contacts/contacts.module.js';
import { AudiencesModule } from './audiences/audiences.module.js';
import { FilesModule } from './files/files.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '.env.local'] }),
    DatabaseModule,
    ContactsModule,
    AudiencesModule,
    FilesModule,
    CategoriesModule,
    CampaignsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}

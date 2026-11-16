import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module.js';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';
import { ZohoCampaignsService } from './zoho-campaigns.service.js';

@Module({ imports: [ContactsModule], controllers: [CampaignsController], providers: [CampaignsService, ZohoCampaignsService] })
export class CampaignsModule {}

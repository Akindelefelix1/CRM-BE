import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module.js';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';
import { ZohoCampaignsService } from './zoho-campaigns.service.js';
import { TermiiService } from './termii.service.js';
import { ZohoWhatsAppService } from './zoho-whatsapp.service.js';

@Module({ imports: [ContactsModule], controllers: [CampaignsController], providers: [CampaignsService, ZohoCampaignsService, TermiiService, ZohoWhatsAppService] })
export class CampaignsModule {}

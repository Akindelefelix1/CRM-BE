import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller.js';
import { ContactsService } from './contacts.service.js';
import { MailService } from './mail.service.js';

@Module({ controllers: [ContactsController], providers: [ContactsService, MailService], exports: [ContactsService, MailService] })
export class ContactsModule {}

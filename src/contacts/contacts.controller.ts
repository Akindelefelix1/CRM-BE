import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ContactsService } from './contacts.service.js';
import { MailService } from './mail.service.js';

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService, private readonly mail: MailService) {}

  @Get() list(@Query('search') search?: string) { return this.contacts.list(search); }
  @Post('bulk') createMany(@Body('contacts') rows: unknown) { return this.contacts.createMany(rows); }
  @Post('bulk-delete') removeMany(@Body('contactIds') ids: unknown) { return this.contacts.removeMany(ids); }
  @Get(':id') get(@Param('id') id: string) { return this.contacts.get(id); }
  @Post() create(@Body() body: Record<string, unknown>) { return this.contacts.create(body); }
  @Post(':id/merge') merge(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.contacts.merge(id, body); }
  @Post(':id/email') async sendEmail(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const contact = await this.contacts.get(id);
    return this.mail.sendContactEmail(contact, body);
  }
  @Patch(':id') update(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.contacts.update(id, body); }
  @Delete(':id') remove(@Param('id') id: string) { return this.contacts.remove(id); }
}

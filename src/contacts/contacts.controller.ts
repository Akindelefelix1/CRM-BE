import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ContactsService } from './contacts.service.js';

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get() list(@Query('search') search?: string) { return this.contacts.list(search); }
  @Get(':id') get(@Param('id') id: string) { return this.contacts.get(id); }
  @Post() create(@Body() body: Record<string, unknown>) { return this.contacts.create(body); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.contacts.update(id, body); }
  @Delete(':id') remove(@Param('id') id: string) { return this.contacts.remove(id); }
}

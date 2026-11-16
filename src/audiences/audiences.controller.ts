import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AudiencesService } from './audiences.service.js';

@Controller('audiences')
export class AudiencesController {
  constructor(private readonly audiences: AudiencesService) {}

  @Get() list() { return this.audiences.list(); }
  @Get(':id') get(@Param('id') id: string) { return this.audiences.get(id); }
  @Post() create(@Body() body: Record<string, unknown>) { return this.audiences.create(body); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.audiences.update(id, body); }
  @Delete(':id') remove(@Param('id') id: string) { return this.audiences.remove(id); }
  @Post(':id/members') addMembers(@Param('id') id: string, @Body('contactIds') ids: string[]) { return this.audiences.addMembers(id, ids); }
  @Delete(':id/members/:contactId') removeMember(@Param('id') id: string, @Param('contactId') contactId: string) { return this.audiences.removeMember(id, contactId); }
}

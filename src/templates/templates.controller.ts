import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { TemplatesService } from './templates.service.js';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get() list() { return this.templates.list(); }
  @Post() create(@Body() body: Record<string, unknown>) { return this.templates.create(body); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.templates.update(id, body); }
  @Post(':id/use') use(@Param('id') id: string) { return this.templates.use(id); }
  @Delete(':id') remove(@Param('id') id: string) { return this.templates.remove(id); }
}

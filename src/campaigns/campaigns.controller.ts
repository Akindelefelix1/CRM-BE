import { Body, Controller, Get, Header, Param, Patch, Post } from '@nestjs/common';
import { CampaignsService } from './campaigns.service.js';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get() list() { return this.campaigns.list(); }
  @Post('test') sendTest(@Body() body: Record<string, unknown>) { return this.campaigns.sendTest(body); }
  @Get(':id/content') @Header('Content-Type', 'text/html; charset=utf-8') content(@Param('id') id: string) { return this.campaigns.content(id); }
  @Post() create(@Body() body: Record<string, unknown>) { return this.campaigns.create(body); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.campaigns.update(id, body); }
  @Post(':id/request-approval') requestApproval(@Param('id') id: string) { return this.campaigns.requestApproval(id); }
  @Post(':id/approve') approve(@Param('id') id: string) { return this.campaigns.approve(id); }
  @Post(':id/schedule') schedule(@Param('id') id: string) { return this.campaigns.schedule(id); }
  @Post(':id/send') send(@Param('id') id: string) { return this.campaigns.sendNow(id); }
  @Post(':id/cancel') cancel(@Param('id') id: string) { return this.campaigns.cancel(id); }
  @Patch(':id/pause') pause(@Param('id') id: string, @Body('paused') paused: unknown) {
    return this.campaigns.pause(id, paused === true);
  }
}

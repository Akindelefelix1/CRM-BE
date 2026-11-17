import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  getReport(@Query('period') period?: string) {
    return this.analytics.getReport(period);
  }
}

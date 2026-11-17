import { BadRequestException, Body, Controller, Get, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SettingsService } from './settings.service.js';

type AuthenticatedRequest = Request & { authUserId?: string };

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest) {
    return this.settings.get(this.ownerId(request));
  }

  @Patch()
  update(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.settings.update(this.ownerId(request), this.record(body));
  }

  @Post('privacy-requests')
  createPrivacyRequest(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.settings.createPrivacyRequest(this.ownerId(request), this.record(body));
  }

  private record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('A valid settings object is required');
    }
    return value as Record<string, unknown>;
  }

  private ownerId(request: AuthenticatedRequest) {
    if (!request.authUserId) throw new UnauthorizedException('A valid sign-in is required');
    return request.authUserId;
  }
}

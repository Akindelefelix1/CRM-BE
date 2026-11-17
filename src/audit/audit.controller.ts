import { BadRequestException, Body, Controller, Get, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService, type CreateAuditEventInput } from './audit.service.js';

type AuthenticatedRequest = Request & { authUserId?: string };

@Controller('audit-events')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const actorId = request.authUserId;
    if (!actorId) throw new UnauthorizedException('A valid sign-in is required');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('A valid audit event object is required');
    }
    return this.audit.create(actorId, body as CreateAuditEventInput);
  }

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('eventType') eventType?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const actorId = request.authUserId;
    if (!actorId) throw new UnauthorizedException('A valid sign-in is required');
    return this.audit.list(actorId, {
      search,
      eventType,
      limit: this.parseInteger(limit, 'limit', 25, 100),
      offset: this.parseInteger(offset, 'offset', 0, 100_000),
    });
  }

  private parseInteger(value: string | undefined, field: string, fallback: number, maximum: number) {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${field} must be a whole number`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > maximum || (field === 'limit' && parsed < 1)) {
      throw new BadRequestException(`${field} must be between ${field === 'limit' ? 1 : 0} and ${maximum}`);
    }
    return parsed;
  }
}

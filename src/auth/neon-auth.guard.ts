import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator.js';

@Injectable()
export class NeonAuthGuard implements CanActivate {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const authBaseUrl = process.env.NEON_AUTH_BASE_URL?.trim();
    if (!authBaseUrl) {
      throw new ServiceUnavailableException('API authentication is not configured');
    }
    let issuer: string;
    let jwksUrl: string;
    try {
      const authUrl = new URL(authBaseUrl);
      issuer = authUrl.origin;
      const configuredJwksUrl = process.env.NEON_AUTH_JWKS_URL?.trim();
      jwksUrl = configuredJwksUrl || `${authBaseUrl.replace(/\/$/, '')}/.well-known/jwks.json`;
      new URL(jwksUrl);
    } catch {
      throw new ServiceUnavailableException('Neon Auth base URL is invalid');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string'
      ? /^Bearer\s+([A-Za-z0-9._~-]+)$/i.exec(authorization)
      : null;
    if (!match) throw new UnauthorizedException('A valid sign-in is required');

    try {
      this.jwks ??= createRemoteJWKSet(new URL(jwksUrl));
      const { payload } = await jwtVerify(match[1], this.jwks, { issuer });
      if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new UnauthorizedException('The access token has no account identity');
      }
      (request as Request & { authUserId?: string }).authUserId = payload.sub;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('The sign-in token is invalid or expired');
    }
  }
}

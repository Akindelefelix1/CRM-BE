import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator.js';

@Controller()
export class AppController {
  @Get('health')
  @Public()
  health() {
    return { status: 'ok', service: 'cephas-crm-api' };
  }
}

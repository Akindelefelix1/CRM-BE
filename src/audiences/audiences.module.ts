import { Module } from '@nestjs/common';
import { AudiencesController } from './audiences.controller.js';
import { AudiencesService } from './audiences.service.js';

@Module({ controllers: [AudiencesController], providers: [AudiencesService] })
export class AudiencesModule {}

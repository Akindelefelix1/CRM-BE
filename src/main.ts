import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));
  const configuredOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV === 'production' && configuredOrigins.length === 0) {
    throw new Error('CORS_ORIGIN must contain the production frontend origin');
  }
  const localDevelopmentOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];
  const allowedOrigins = process.env.NODE_ENV === 'production'
    ? configuredOrigins
    : [...configuredOrigins, ...localDevelopmentOrigins];
  app.enableCors({
    origin: [...new Set(allowedOrigins)],
  });
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

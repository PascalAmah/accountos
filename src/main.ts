import './config/config'; // validates all env vars at startup — exits if any are missing
import { appConfig } from './config/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { PrismaService } from './prisma/prisma.service';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { BigIntSerializeInterceptor } from './common/interceptors/bigint-serialize.interceptor';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  // Security headers (OWASP A05). CSP is relaxed just enough for the static demo
  // dashboard (public/dashboard.html), which loads Chart.js/Tabler/Google Fonts
  // from CDNs and uses one big inline <script> + inline onclick handlers.
  // NOTE: 'unsafe-inline' (incl. scriptSrcAttr for onclick) is acceptable for a
  // local demo page; a production surface should move that JS to a served file.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://cdnjs.cloudflare.com',
            'https://cdn.jsdelivr.net',
          ],
          scriptSrcAttr: ["'unsafe-inline'"], // inline onclick= handlers
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
            'https://cdn.jsdelivr.net',
          ],
          fontSrc: [
            "'self'",
            'https://fonts.gstatic.com',
            'https://cdn.jsdelivr.net',
          ],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'https://cdn.jsdelivr.net'], // API (same origin) + CDN sourcemaps
        },
      },
    }),
  );

  // CORS
  app.enableCors({
    origin:
      appConfig.CORS_ORIGINS === '*'
        ? '*'
        : appConfig.CORS_ORIGINS.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'x-admin-secret'],
    credentials: false,
  });

  // Pino logger
  app.useLogger(app.get(Logger));

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  // Exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Request ID interceptor
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new IdempotencyInterceptor(app.get(PrismaService)),
    new BigIntSerializeInterceptor(),
  );

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AccountOS API')
    .setDescription('Programmable virtual account state machine on Nomba')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Serve static demo/brand pages from /public
  app.useStaticAssets(join(process.cwd(), 'public'));

  await app.listen(appConfig.PORT, '0.0.0.0');
}
void bootstrap();

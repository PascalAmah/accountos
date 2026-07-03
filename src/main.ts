import './config/config'; // validates all env vars at startup — exits if any are missing
import { appConfig } from './config/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { BigIntSerializeInterceptor } from './common/interceptors/bigint-serialize.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
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

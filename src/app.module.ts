import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { NombaClientModule } from './nomba-client/nomba-client.module';
import { ApiKeyGuard } from './auth/api-key.guard';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { QueueModule } from './common/queue/queue.module';
import { LedgerModule } from './ledger/ledger.module';
import { AccountsModule } from './accounts/accounts.module';
import { RulesModule } from './rules/rules.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { EventsModule } from './events/events.module';
import { DemoModule } from './demo/demo.module';
import { TreasuryModule } from './treasury/treasury.module';
import { SchedulerModule } from './common/scheduler/scheduler.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { appConfig } from './config/config';

// Headers and body fields to redact from all request logs
const REDACTED_HEADERS = [
  'x-api-key',
  'x-admin-secret',
  'authorization',
  'cookie',
];
const REDACTED_BODY_FIELDS = [
  'nombaClientSecret',
  'nombaWebhookSecret',
  'password',
  'secret',
  'token',
];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // ── Rate limiting ──────────────────────────────────────────────────────
    // ONE global limiter for authenticated API traffic. Stricter admin/webhook
    // limits are applied PER-ROUTE via @Throttle — NOT registered globally.
    // (Every named throttler registered here is enforced on EVERY request, so a
    // global 'admin' bucket would throttle the whole API at its low 10/min limit.)
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: appConfig.THROTTLE_API_TTL,
        limit: appConfig.THROTTLE_API_LIMIT,
      },
    ]),

    LoggerModule.forRoot({
      pinoHttp: {
        level: appConfig.NODE_ENV !== 'production' ? 'debug' : 'info',
        transport:
          appConfig.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        redact: {
          paths: [
            ...REDACTED_HEADERS.map((h) => `req.headers["${h}"]`),
            ...REDACTED_BODY_FIELDS.map((f) => `req.body.${f}`),
          ],
          censor: '[REDACTED]',
        },
        serializers: {
          req(req: {
            headers: Record<string, unknown>;
            body: Record<string, unknown>;
          }) {
            const headers = { ...req.headers };
            for (const h of REDACTED_HEADERS) {
              if (headers[h]) headers[h] = '[REDACTED]';
            }
            const body = { ...req.body };
            for (const f of REDACTED_BODY_FIELDS) {
              if (body[f]) body[f] = '[REDACTED]';
            }
            return { ...req, headers, body };
          },
        },
      },
    }),

    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    AuditModule,
    IdentityModule,
    QueueModule,
    LedgerModule,
    AccountsModule,
    RulesModule,
    NombaClientModule,
    WebhooksModule,
    EventsModule,
    DemoModule,
    TreasuryModule,
    SchedulerModule,
    MetricsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

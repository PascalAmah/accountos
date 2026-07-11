import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';
import { appConfig } from '../config/config';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check — returns DB and Redis status' })
  async check(): Promise<{
    status: 'ok';
    db: 'connected' | 'error';
    redis: 'connected' | 'error';
    version: string;
    queueDepth: { pending: number; failed: number };
    timestamp: string;
  }> {
    const [db, redis, pending, failed] = await Promise.all([
      this.healthService.checkDb(),
      this.healthService.checkRedis(),
      this.prisma.ruleExecution.count({ where: { status: 'PENDING' } }),
      this.prisma.ruleExecution.count({ where: { status: 'FAILED' } }),
    ]);

    return {
      status: 'ok',
      db,
      redis,
      version: appConfig.APP_VERSION,
      queueDepth: { pending, failed },
      timestamp: new Date().toISOString(),
    };
  }
}

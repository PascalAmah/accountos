import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { HealthService } from './health.service';
import { appConfig } from '../config/config';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check — returns DB and Redis status' })
  async check(): Promise<{
    status: 'ok';
    db: 'connected' | 'error';
    redis: 'connected' | 'error';
    version: string;
    timestamp: string;
  }> {
    const [db, redis] = await Promise.all([
      this.healthService.checkDb(),
      this.healthService.checkRedis(),
    ]);

    return {
      status: 'ok',
      db,
      redis,
      version: appConfig.APP_VERSION,
      timestamp: new Date().toISOString(),
    };
  }
}

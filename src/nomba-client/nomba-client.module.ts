import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NombaClientService } from './nomba-client.service';

@Module({
  imports: [AuthModule],
  providers: [NombaClientService],
  exports: [NombaClientService],
})
export class NombaClientModule {}

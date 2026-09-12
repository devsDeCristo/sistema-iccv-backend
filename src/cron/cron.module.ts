import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CronService } from './cron.service';
import { GatewaysModule } from 'src/gateways/gateways.module';

@Module({
  imports: [ScheduleModule.forRoot(), GatewaysModule],
  providers: [CronService],
})
export class CronModule {}

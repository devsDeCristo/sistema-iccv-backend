import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { GatewaysModule } from 'src/gateways/gateways.module';
import { CronModule } from 'src/cron/cron.module';

@Module({
  imports: [GatewaysModule, CronModule],
  controllers: [PaymentController],
  providers: [PaymentService, PrismaService],
  exports: [PaymentService],
})
export class PaymentModule {}

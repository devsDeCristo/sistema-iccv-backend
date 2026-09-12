import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PaymentModule } from '../payment/payment.module';
import { GatewaysModule } from 'src/gateways/gateways.module';

@Module({
  imports: [PaymentModule, GatewaysModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}

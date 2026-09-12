import { Module } from '@nestjs/common';
import { GatewaysModule } from 'src/gateways/gateways.module';
import { PaymentProviderController } from './payment-provider.controller';
import { PaymentProviderService } from './payment-provider.service';

@Module({
  imports: [GatewaysModule],
  controllers: [PaymentProviderController],
  providers: [PaymentProviderService],
})
export class PaymentProviderModule {}

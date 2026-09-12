import { Module } from '@nestjs/common';
import { PagbankClient } from './pagbank/pagbank.client';
import { PagbankGateway } from './pagbank/pagbank.gateway';
import { MercadoPagoClient } from './mercadopago/mercadopago.client';
import { MercadoPagoGateway } from './mercadopago/mercadopago.gateway';
import { InfinitePayClient } from './infinitepay/infinitepay.client';
import { InfinitePayGateway } from './infinitepay/infinitepay.gateway';
import { TonClient } from './ton/ton.client';
import { TonGateway } from './ton/ton.gateway';
import {
  PAYMENT_GATEWAYS,
  PaymentGateway,
} from './core/payment-gateway.interface';
import { PaymentGatewayRegistry } from './core/payment-gateway.registry';

/**
 * Onde as casas de pagamento são registradas.
 *
 * É o único arquivo que precisa mudar para uma integração nova entrar no
 * sistema: acrescentar o adapter aos `providers` e ao `inject` abaixo, mais um
 * valor no enum `PaymentProvider` e um apelido em `provider-slug.ts`. O fluxo
 * de cobrança, a tela de configurações, o webhook e a reconciliação passam a
 * enxergá-la sozinhos — todos os três leem do registry, não de uma lista
 * própria.
 */
@Module({
  providers: [
    PagbankClient,
    PagbankGateway,
    MercadoPagoClient,
    MercadoPagoGateway,
    InfinitePayClient,
    InfinitePayGateway,
    TonClient,
    TonGateway,
    {
      provide: PAYMENT_GATEWAYS,
      useFactory: (...gateways: PaymentGateway[]) => gateways,
      inject: [
        PagbankGateway,
        MercadoPagoGateway,
        InfinitePayGateway,
        TonGateway,
      ],
    },
    PaymentGatewayRegistry,
  ],
  exports: [PaymentGatewayRegistry],
})
export class GatewaysModule {}

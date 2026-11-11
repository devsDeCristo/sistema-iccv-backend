import {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
} from '@prisma/client';
import { MercadoPagoGateway } from './mercadopago/mercadopago.gateway';
import { TonGateway } from './ton/ton.gateway';
import { GatewayContext } from './core/gateway.types';

/**
 * "Outro" no sistema também quer dizer "forma ainda não definida". Pagamento
 * que o gateway confirmou não pode cair nele quando o gateway disse como foi
 * pago — a tesouraria precisa saber, e a tela de Minhas Inscrições usa "Outro"
 * para decidir se há cobrança em andamento.
 */
const ctx = (provider: PaymentProvider): GatewayContext => ({
  churchId: 'igreja-1',
  configId: 'config-1',
  provider,
  mode: PaymentProviderMode.PRODUCTION,
  credentials: { accessToken: 'x', secretKey: 'sk_x' },
});

describe('Mercado Pago — forma de pagamento', () => {
  const metodo = async (tipo: string) => {
    const client = {
      searchPayments: jest.fn().mockResolvedValue([
        {
          id: 1,
          status: 'approved',
          payment_type_id: tipo,
          transaction_amount: 10,
          date_created: '2026-11-11T12:00:00Z',
        },
      ]),
    };
    const [charge] = await new MercadoPagoGateway(client as any).listCharges(
      'ref-1',
      ctx(PaymentProvider.MERCADO_PAGO),
    );
    return charge.method;
  };

  it('saldo, Linha de Crédito e carteiras viram conta digital', async () => {
    expect(await metodo('account_money')).toBe(PaymentMethod.WALLET);
    expect(await metodo('digital_currency')).toBe(PaymentMethod.WALLET);
    expect(await metodo('digital_wallet')).toBe(PaymentMethod.WALLET);
  });

  it('pré-pago vira débito', async () => {
    expect(await metodo('prepaid_card')).toBe(PaymentMethod.DEBIT_CARD);
  });

  it('o que o mapa não conhece continua "outro" — e o valor cru fica no payload', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await metodo('crypto_transfer')).toBe(PaymentMethod.OTHER);
  });
});

describe('Ton — forma de pagamento', () => {
  const metodo = async (tipo: string) => {
    const client = {
      findOrdersByCode: jest.fn().mockResolvedValue([
        {
          charges: [
            {
              id: 'ch_1',
              status: 'paid',
              payment_method: tipo,
              amount: 1000,
              created_at: '2026-11-11T12:00:00Z',
            },
          ],
        },
      ]),
    };
    const [charge] = await new TonGateway(client as any).listCharges(
      'ref-1',
      ctx(PaymentProvider.TON),
    );
    return charge.method;
  };

  it('cartão de loja é crédito, dinheiro é dinheiro', async () => {
    expect(await metodo('private_label')).toBe(PaymentMethod.CREDIT_CARD);
    expect(await metodo('cash')).toBe(PaymentMethod.CASH);
  });
});

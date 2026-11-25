import { UnprocessableEntityException } from '@nestjs/common';
import { PaymentMethod, PaymentProvider, PaymentStatus } from '@prisma/client';
import {
  escolhasComPixNaTela,
  querPixNaTela,
  rotuloDoCheckout,
} from './core/opcoes-de-pagamento';
import { GatewayResourceNotFoundError } from './core/gateway.errors';
import { MercadoPagoGateway } from './mercadopago/mercadopago.gateway';
import { PagbankGateway } from './pagbank/pagbank.gateway';
import { TonGateway } from './ton/ton.gateway';
import { PayPalGateway } from './paypal/paypal.gateway';

/**
 * O Pix pago na nossa tela, fora do PayPal: com o Pix ligado, ele sai do
 * checkout do gateway e vira uma order com QR dinâmico; as outras formas
 * continuam no checkout.
 */
const pedido: any = {
  referenceId: 'ref-1',
  eventId: 'ev-1',
  eventName: 'Retiro',
  customer: {
    name: 'Ana Souza',
    email: 'ana@x.com',
    taxId: '123.456.789-09',
    phone: { country: '55', area: '71', number: '999999999' },
  },
  items: [
    {
      referenceId: 'i-1',
      name: 'Inscrição',
      quantity: 1,
      unitAmountCents: 12000,
    },
  ],
  discountCents: 0,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  paymentNotificationUrl: 'https://api/webhooks/x/segredo/payments',
  checkoutNotificationUrl: 'https://api/webhooks/x/segredo/checkouts',
  redirectUrl: 'https://site/eventos/ev-1',
  softDescriptor: 'IGREJA',
  paymentMethod: PaymentMethod.PIX,
};

const ctx = (provider: PaymentProvider, credentials: object = {}): any => ({
  churchId: 'igreja-1',
  configId: 'cfg-1',
  provider,
  mode: 'PRODUCTION',
  credentials: { accessToken: 't', token: 't', secretKey: 's', ...credentials },
});

describe('Pix na tela — a regra comum', () => {
  it('pergunta só com Pix ligado; só o Pix não é pergunta', () => {
    expect(
      escolhasComPixNaTela([PaymentMethod.PIX, PaymentMethod.BOLETO]),
    ).toEqual([PaymentMethod.PIX, PaymentMethod.CREDIT_CARD]);
    expect(escolhasComPixNaTela([PaymentMethod.PIX])).toEqual([
      PaymentMethod.PIX,
    ]);
    expect(escolhasComPixNaTela([PaymentMethod.BOLETO])).toEqual([]);
  });

  it('o pedido sai em Pix escolhido, ou por ser a única forma', () => {
    const ambas = [PaymentMethod.PIX, PaymentMethod.CREDIT_CARD];
    expect(querPixNaTela(ambas, PaymentMethod.PIX)).toBe(true);
    expect(querPixNaTela(ambas, PaymentMethod.CREDIT_CARD)).toBe(false);
    expect(querPixNaTela([PaymentMethod.PIX])).toBe(true);
    expect(querPixNaTela([PaymentMethod.BOLETO], PaymentMethod.PIX)).toBe(
      false,
    );
  });

  it('o nome da outra saída segue o que a igreja ligou', () => {
    const mp = new MercadoPagoGateway({} as any).descriptor.fields;
    expect(rotuloDoCheckout(mp, {})).toBe('Cartão ou boleto');
    expect(rotuloDoCheckout(mp, { enabledMethods: 'PIX,BOLETO' })).toBe(
      'Boleto',
    );
    const paypal = new PayPalGateway({} as any).descriptor.fields;
    expect(rotuloDoCheckout(paypal, {})).toBe('Cartão ou conta PayPal');
  });
});

describe('Pix na tela — Ton', () => {
  it('cria o pedido com pagamento pix e devolve o código, sem link', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'or_1',
        charges: [
          {
            last_transaction: {
              qr_code: '00020101pix',
              expires_at: '2026-11-24T20:00:00Z',
            },
          },
        ],
      }),
    };

    const r = await new TonGateway(client as any).createCheckout(
      pedido,
      ctx(PaymentProvider.TON),
    );

    const corpo = client.createOrder.mock.calls[0][0];
    expect(corpo.code).toBe('ref-1');
    expect(corpo.payments[0].payment_method).toBe('pix');
    expect(corpo.payments[0].pix.expires_in).toBeGreaterThan(0);
    expect(r).toMatchObject({
      checkoutId: 'or_1',
      payUrl: '',
      pix: { code: '00020101pix' },
    });
  });

  it('pedido sem código (conta sem Pix) vira "escolha outra forma" e é fechado', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'or_2',
        charges: [{ last_transaction: { status: 'failed' } }],
      }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      new TonGateway(client as any).createCheckout(
        pedido,
        ctx(PaymentProvider.TON),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(client.cancelOrder).toHaveBeenCalledWith(
      'or_2',
      expect.anything(),
      'PRODUCTION',
    );
  });

  it('o cartão vai para o checkout sem o Pix', async () => {
    const client = {
      createOrder: jest
        .fn()
        .mockResolvedValue({ id: 'or_3', checkouts: [{ payment_url: 'u' }] }),
    };

    await new TonGateway(client as any).createCheckout(
      { ...pedido, paymentMethod: PaymentMethod.CREDIT_CARD },
      ctx(PaymentProvider.TON),
    );

    const checkout = client.createOrder.mock.calls[0][0].payments[0].checkout;
    expect(checkout.accepted_payment_methods).toEqual([
      'credit_card',
      'boleto',
    ]);
  });
});

describe('Pix na tela — Mercado Pago', () => {
  const orderPaga = {
    id: 'ORD01ABC',
    external_reference: 'ref-1',
    status: 'processed',
    status_detail: 'accredited',
    total_paid_amount: '120.00',
    transactions: {
      payments: [
        {
          id: 'PAY01',
          payment_method: { id: 'pix', type: 'bank_transfer' },
        },
      ],
    },
  };

  it('cria a order online de Pix e devolve o código', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'ORD01ABC',
        status: 'action_required',
        transactions: {
          payments: [
            {
              payment_method: { qr_code: '00020101mp' },
              date_of_expiration: '2026-11-24T20:00:00Z',
            },
          ],
        },
      }),
    };

    const r = await new MercadoPagoGateway(client as any).createCheckout(
      pedido,
      ctx(PaymentProvider.MERCADO_PAGO),
    );

    const [corpo, , chave] = client.createOrder.mock.calls[0];
    expect(corpo).toMatchObject({
      type: 'online',
      processing_mode: 'automatic',
      external_reference: 'ref-1',
      total_amount: '120.00',
      payer: { identification: { type: 'CPF', number: '12345678909' } },
    });
    expect(corpo.transactions.payments[0]).toMatchObject({
      amount: '120.00',
      payment_method: { id: 'pix', type: 'bank_transfer' },
    });
    expect(corpo.transactions.payments[0].expiration_time).toMatch(/^PT\d+M$/);
    // a referência é a chave de idempotência: duplo clique não abre duas
    expect(chave).toBe('ref-1');
    expect(r).toMatchObject({
      checkoutId: 'ORD01ABC',
      payUrl: '',
      pix: { code: '00020101mp' },
    });
  });

  it('consulta pela order, com o valor pago em centavos', async () => {
    const client = { getOrder: jest.fn().mockResolvedValue(orderPaga) };

    const [charge] = await new MercadoPagoGateway(client as any).listCharges(
      'ref-1',
      ctx(PaymentProvider.MERCADO_PAGO),
      'ORD01ABC',
    );

    expect(charge).toMatchObject({
      status: PaymentStatus.PAID,
      method: PaymentMethod.PIX,
      paidAmountCents: 12000,
    });
  });

  it('order que o Mercado Pago não conhece é "não encontrada"', async () => {
    const client = { getOrder: jest.fn().mockResolvedValue(null) };

    await expect(
      new MercadoPagoGateway(client as any).listCharges(
        'ref-1',
        ctx(PaymentProvider.MERCADO_PAGO),
        'ORD01ABC',
      ),
    ).rejects.toBeInstanceOf(GatewayResourceNotFoundError);
  });

  it('o aviso do tipo order é confirmado na API, pela referência dela', async () => {
    const client = { getOrder: jest.fn().mockResolvedValue(orderPaga) };

    const evento = await new MercadoPagoGateway(client as any).parseWebhook(
      {
        body: { type: 'order', data: { id: 'ORD01ABC' } },
        query: {},
        headers: {},
      } as any,
      ctx(PaymentProvider.MERCADO_PAGO),
    );

    expect(client.getOrder).toHaveBeenCalledWith('ORD01ABC', expect.anything());
    expect(evento).toMatchObject({
      kind: 'payment',
      referenceId: 'ref-1',
      status: PaymentStatus.PAID,
      paidAmountCents: 12000,
    });
  });

  it('Pix substituído: a order é cancelada; preferência segue expirando', async () => {
    const client = {
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      expirePreference: jest.fn().mockResolvedValue(undefined),
    };
    const gateway = new MercadoPagoGateway(client as any);

    await gateway.inactivateCheckout(
      'ORD01ABC',
      ctx(PaymentProvider.MERCADO_PAGO),
    );
    await gateway.inactivateCheckout(
      '123-abc',
      ctx(PaymentProvider.MERCADO_PAGO),
    );

    expect(client.cancelOrder).toHaveBeenCalledWith(
      'ORD01ABC',
      expect.anything(),
    );
    expect(client.expirePreference).toHaveBeenCalledWith(
      '123-abc',
      expect.anything(),
    );
  });
});

describe('Pix na tela — PagBank', () => {
  const orderPaga = {
    id: 'ORDE_1',
    reference_id: 'ref-1',
    charges: [
      {
        id: 'CHAR_1',
        status: 'PAID',
        created_at: '2026-11-24T19:00:00Z',
        amount: { value: 12000, summary: { paid: 12000 } },
        payment_method: { type: 'PIX' },
      },
    ],
  };

  it('cria a order com cobrança PIX (não o QR da carteira) e devolve o código', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'ORDE_1',
        charges: [
          {
            status: 'WAITING',
            qr_code: { text: '00020101pb' },
            payment_method: {
              pix: { expiration_date: '2026-11-24T20:00:00Z' },
            },
          },
        ],
      }),
    };

    const r = await new PagbankGateway(client as any).createCheckout(
      pedido,
      ctx(PaymentProvider.PAGBANK),
    );

    const corpo = client.createOrder.mock.calls[0][0];
    expect(corpo.qr_codes).toBeUndefined();
    expect(corpo.reference_id).toBe('ref-1');
    expect(corpo.customer.tax_id).toBe('12345678909');
    expect(corpo.charges[0]).toMatchObject({
      reference_id: 'ref-1',
      amount: { value: 12000, currency: 'BRL' },
      payment_method: { type: 'PIX' },
    });
    expect(corpo.notification_urls).toEqual([pedido.paymentNotificationUrl]);
    expect(r).toMatchObject({
      checkoutId: 'ORDE_1',
      payUrl: '',
      pix: { code: '00020101pb' },
    });
  });

  it('consulta pela order quando o checkout é uma order de Pix', async () => {
    const client = {
      getOrder: jest.fn().mockResolvedValue(orderPaga),
      getCharges: jest.fn(),
    };

    const [charge] = await new PagbankGateway(client as any).listCharges(
      'ref-1',
      ctx(PaymentProvider.PAGBANK),
      'ORDE_1',
    );

    expect(client.getCharges).not.toHaveBeenCalled();
    expect(charge).toMatchObject({
      status: PaymentStatus.PAID,
      method: PaymentMethod.PIX,
      paidAmountCents: 12000,
    });
  });

  it('o checkout de sempre continua pela busca por referência', async () => {
    const client = {
      getOrder: jest.fn(),
      getCharges: jest.fn().mockResolvedValue(orderPaga.charges),
    };

    await new PagbankGateway(client as any).listCharges(
      'ref-1',
      ctx(PaymentProvider.PAGBANK),
      'CHEC_1',
    );

    expect(client.getOrder).not.toHaveBeenCalled();
  });

  it('aviso de order que a busca por referência não acha é confirmado pela order', async () => {
    const client = {
      getCharges: jest
        .fn()
        .mockRejectedValue(
          new GatewayResourceNotFoundError('PagBank', 'ref-1'),
        ),
      getOrder: jest.fn().mockResolvedValue(orderPaga),
    };

    const evento = await new PagbankGateway(client as any).parseWebhook(
      {
        body: { id: 'ORDE_1', reference_id: 'ref-1', charges: [{}] },
        headers: {},
        query: {},
      } as any,
      ctx(PaymentProvider.PAGBANK),
    );

    expect(evento).toMatchObject({
      kind: 'payment',
      referenceId: 'ref-1',
      status: PaymentStatus.PAID,
      paidAmountCents: 12000,
    });
  });

  it('fora da order de Pix, o "não encontrado" segue para o PagBank tentar de novo', async () => {
    const client = {
      getCharges: jest
        .fn()
        .mockRejectedValue(
          new GatewayResourceNotFoundError('PagBank', 'ref-1'),
        ),
      getOrder: jest.fn(),
    };

    await expect(
      new PagbankGateway(client as any).parseWebhook(
        {
          body: { id: 'CHAR_9', reference_id: 'ref-1', charges: [{}] },
          headers: {},
          query: {},
        } as any,
        ctx(PaymentProvider.PAGBANK),
      ),
    ).rejects.toBeInstanceOf(GatewayResourceNotFoundError);
    expect(client.getOrder).not.toHaveBeenCalled();
  });
});

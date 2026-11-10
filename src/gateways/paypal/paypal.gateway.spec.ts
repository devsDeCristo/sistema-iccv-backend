import {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
  PaymentStatus,
} from '@prisma/client';
import { PayPalGateway } from './paypal.gateway';
import { GatewayResourceNotFoundError } from '../core/gateway.errors';
import { GatewayContext, HostedCheckoutRequest } from '../core/gateway.types';

const ctx: GatewayContext = {
  churchId: 'igreja-1',
  configId: 'config-1',
  provider: PaymentProvider.PAYPAL,
  mode: PaymentProviderMode.SANDBOX,
  credentials: { clientId: 'cid', clientSecret: 'sec' },
};

const pedido = (status: string, captura?: Record<string, unknown>) => ({
  id: 'ORDER-1',
  status,
  create_time: '2026-11-10T12:00:00Z',
  payment_source: { paypal: {} },
  purchase_units: [
    {
      reference_id: 'ref-1',
      payments: captura ? { captures: [captura] } : undefined,
    },
  ],
});

const capturaPaga = {
  id: 'CAP-1',
  status: 'COMPLETED',
  create_time: '2026-11-10T12:05:00Z',
  amount: { currency_code: 'BRL', value: '120.00' },
};

describe('PayPal — criação do pedido', () => {
  const request: HostedCheckoutRequest = {
    referenceId: 'ref-1',
    eventId: 'ev-1',
    eventName: 'Retiro',
    customer: {
      name: 'Fulano',
      email: 'f@x.com',
      taxId: '000',
      phone: { country: '55', area: '11', number: '999999999' },
    },
    items: [
      {
        referenceId: 'a',
        name: 'Ingresso',
        description: 'Ingresso',
        quantity: 1,
        unitAmountCents: 10000,
      },
      {
        referenceId: 'b',
        name: 'Camiseta',
        description: 'Camiseta',
        quantity: 2,
        unitAmountCents: 2500,
      },
    ],
    discountCents: 3000,
    expiresAt: new Date(),
    paymentNotificationUrl: 'https://api/x',
    checkoutNotificationUrl: 'https://api/y',
    redirectUrl: 'https://front/events/ev-1',
    softDescriptor: 'Igreja de cristo',
  };

  it('manda o total igual à soma dos itens, já com desconto, em reais', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'ORDER-1',
        links: [
          { rel: 'self', href: 'https://api/self' },
          { rel: 'payer-action', href: 'https://paypal/checkoutnow?token=1' },
        ],
      }),
    };
    const gateway = new PayPalGateway(client as any);

    const resultado = await gateway.createCheckout(request, ctx);

    const [payload, , , requestId] = client.createOrder.mock.calls[0];
    const unidade = payload.purchase_units[0];
    const somaDosItens = unidade.items.reduce(
      (soma: number, i: any) =>
        soma +
        Math.round(Number(i.unit_amount.value) * 100) * Number(i.quantity),
      0,
    );

    // 150,00 em itens - 30,00 de desconto. O PayPal recusa o pedido inteiro
    // quando item_total não é exatamente a soma dos itens.
    expect(unidade.amount.value).toBe('120.00');
    expect(unidade.amount.breakdown.item_total.value).toBe('120.00');
    expect(somaDosItens).toBe(12000);
    expect(unidade.reference_id).toBe('ref-1');
    expect(requestId).toBe('ref-1');
    expect(resultado).toMatchObject({
      checkoutId: 'ORDER-1',
      payUrl: 'https://paypal/checkoutnow?token=1',
    });
  });
});

describe('PayPal — consulta e captura', () => {
  const comPedidos = (...respostas: any[]) => {
    const getOrder = jest.fn();
    respostas.forEach((r) => getOrder.mockResolvedValueOnce(r));
    return { getOrder, captureOrder: jest.fn().mockResolvedValue(undefined) };
  };

  it('captura o pedido aprovado e devolve pago, com o valor que entrou', async () => {
    const client = comPedidos(
      pedido('APPROVED'),
      pedido('COMPLETED', capturaPaga),
    );
    const gateway = new PayPalGateway(client as any);

    const [charge] = await gateway.listCharges('ref-1', ctx, 'ORDER-1');

    // Sem a captura, aprovar no PayPal não move dinheiro nenhum
    expect(client.captureOrder).toHaveBeenCalledWith(
      'ORDER-1',
      expect.anything(),
      ctx.mode,
    );
    expect(charge).toMatchObject({
      status: PaymentStatus.PAID,
      method: PaymentMethod.OTHER,
      paidAmountCents: 12000,
      payload: { codeTransaction: 'CAP-1' },
    });
  });

  it('não captura pedido que o comprador ainda não aprovou', async () => {
    const client = comPedidos(pedido('PAYER_ACTION_REQUIRED'));
    const gateway = new PayPalGateway(client as any);

    const [charge] = await gateway.listCharges('ref-1', ctx, 'ORDER-1');

    expect(client.captureOrder).not.toHaveBeenCalled();
    expect(charge.status).toBe(PaymentStatus.WAITING);
  });

  it('captura pendente fica em análise, não paga', async () => {
    const gateway = new PayPalGateway(
      comPedidos(
        pedido('COMPLETED', { ...capturaPaga, status: 'PENDING' }),
      ) as any,
    );

    const [charge] = await gateway.listCharges('ref-1', ctx, 'ORDER-1');

    expect(charge.status).toBe(PaymentStatus.IN_ANALYSIS);
  });

  it('pedido expirado (404) é "não encontrado", não erro', async () => {
    const gateway = new PayPalGateway(comPedidos(null) as any);

    await expect(
      gateway.listCharges('ref-1', ctx, 'ORDER-1'),
    ).rejects.toBeInstanceOf(GatewayResourceNotFoundError);
  });

  it('recusa pedido de outra referência', async () => {
    const gateway = new PayPalGateway(
      comPedidos(pedido('COMPLETED', capturaPaga)) as any,
    );

    await expect(
      gateway.listCharges('ref-outra', ctx, 'ORDER-1'),
    ).rejects.toBeInstanceOf(GatewayResourceNotFoundError);
  });

  it('sem o id do pedido não há o que consultar', async () => {
    const client = comPedidos();
    const gateway = new PayPalGateway(client as any);

    await expect(gateway.listCharges('ref-1', ctx)).rejects.toBeInstanceOf(
      GatewayResourceNotFoundError,
    );
    expect(client.getOrder).not.toHaveBeenCalled();
  });
});

import {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
  PaymentStatus,
} from '@prisma/client';
import { PayPalGateway } from './paypal.gateway';
import { Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  GatewayRequestError,
  GatewayResourceNotFoundError,
} from '../core/gateway.errors';
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
  redirectUrl: 'https://front/eventos/ev-1',
  softDescriptor: 'Igreja de cristo',
};

describe('PayPal — criação do pedido', () => {
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

describe('PayPal — Pix na tela do sistema', () => {
  const comPix = { ...ctx, credentials: { ...ctx.credentials, pix: 'true' } };

  it('só pergunta a forma de pagamento quando a igreja ligou o Pix', () => {
    const gateway = new PayPalGateway({} as any);

    // Desligado é o padrão: a conta PayPal precisa ter o Pix habilitado, e
    // oferecer sem isso é oferecer um botão que dá erro.
    expect(gateway.paymentMethodChoices(ctx)).toEqual([]);
    expect(gateway.paymentMethodChoices(comPix)).toEqual([
      PaymentMethod.PIX,
      PaymentMethod.CREDIT_CARD,
    ]);
  });

  it('cria o pedido de Pix e devolve o copia e cola, sem link', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'ORDER-PIX',
        status: 'PAYER_ACTION_REQUIRED',
        payment_source: {
          pix: { qr_payload: '00020101...6304E7DB', qr_expiry: '3600' },
        },
        links: [{ rel: 'self', href: 'https://api/self' }],
      }),
    };
    const gateway = new PayPalGateway(client as any);
    const antes = Date.now();

    const resultado = await gateway.createCheckout(
      {
        ...request,
        paymentMethod: PaymentMethod.PIX,
        customer: { ...request.customer, taxId: '123.456.789-09' },
        expiresAt: new Date(antes + 60 * 60 * 1000),
      },
      comPix,
    );

    const [payload] = client.createOrder.mock.calls[0];

    expect(payload.payment_source.paypal).toBeUndefined();
    const pix = payload.payment_source.pix;
    // os nomes que a API aceita — a documentação do Pix fala em `email_id`,
    // `phone_number` e `CPF`, e a API recusou os três em produção
    expect(pix).toMatchObject({
      country_code: 'BR',
      currency_code: 'BRL',
      email: 'f@x.com',
      // só dígitos: o PayPal recusa CPF com pontuação
      tax_info: { tax_id: '12345678909', tax_id_type: 'BR_CPF' },
      phone: { country_code: '55', national_number: '11999999999' },
    });
    expect(pix.email_id).toBeUndefined();
    expect(pix.phone_number).toBeUndefined();
    // captura automática: Pix pago não espera o servidor
    expect(payload.processing_instruction).toBe(
      'ORDER_COMPLETE_ON_PAYMENT_APPROVAL',
    );
    // o valor é o mesmo do cartão — a forma não muda a conta
    expect(payload.purchase_units[0].amount.value).toBe('120.00');

    expect(resultado.checkoutId).toBe('ORDER-PIX');
    expect(resultado.payUrl).toBe('');
    expect(resultado.pix?.code).toBe('00020101...6304E7DB');
    expect(resultado.pix?.expiresAt.getTime()).toBeGreaterThanOrEqual(
      antes + 3600 * 1000,
    );
  });

  it('respeita o mínimo de 10 minutos de validade do PayPal', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'X',
        payment_source: { pix: { qr_payload: '000201...' } },
      }),
    };
    const gateway = new PayPalGateway(client as any);

    await gateway.createCheckout(
      {
        ...request,
        paymentMethod: PaymentMethod.PIX,
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
      comPix,
    );

    expect(
      client.createOrder.mock.calls[0][0].payment_source.pix.qr_expiry,
    ).toBe('600');
  });

  it('Pix recusado pelo PayPal vira "escolha cartão", e não "PayPal fora do ar"', async () => {
    const recusa = new GatewayRequestError('PayPal', {
      name: 'INVALID_REQUEST',
      details: [{ issue: 'MISSING_REQUIRED_PARAMETER' }],
    });
    const gateway = new PayPalGateway({
      createOrder: jest.fn().mockRejectedValue(recusa),
    } as any);

    const erro = await gateway
      .createCheckout({ ...request, paymentMethod: PaymentMethod.PIX }, comPix)
      .catch((e) => e);

    expect(erro).toBeInstanceOf(UnprocessableEntityException);
    expect(erro.message).toBe(
      'O Pix não está disponível agora. Escolha cartão ou conta PayPal.',
    );
  });

  it('PayPal fora do ar no Pix continua com a mensagem de tentar de novo', async () => {
    // 5xx e rede não são recusa do Pix: aí tentar mais tarde é a saída certa
    const foraDoAr = new GatewayRequestError('PayPal', {
      name: 'INTERNAL_SERVER_ERROR',
    });
    const gateway = new PayPalGateway({
      createOrder: jest.fn().mockRejectedValue(foraDoAr),
    } as any);

    const erro = await gateway
      .createCheckout({ ...request, paymentMethod: PaymentMethod.PIX }, comPix)
      .catch((e) => e);

    expect(erro).toBe(foraDoAr);
  });

  it('recusa no cartão não ganha a mensagem do Pix', async () => {
    const recusa = new GatewayRequestError('PayPal', {
      name: 'INVALID_REQUEST',
    });
    const gateway = new PayPalGateway({
      createOrder: jest.fn().mockRejectedValue(recusa),
    } as any);

    const erro = await gateway.createCheckout(request, comPix).catch((e) => e);

    expect(erro).toBe(recusa);
  });

  it('acha o código dentro de `qr_details`, o formato que a produção devolveu', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'ORDER-PIX',
        status: 'PAYER_ACTION_REQUIRED',
        payment_source: {
          pix: {
            name: 'Fulano',
            // o nome do campo de dentro não é documentado: o código é achado
            // pelo prefixo do BR Code, e o `pix://` do QR em imagem não casa
            qr_details: {
              qr_image: 'pix://pay?ver=1.0',
              qualquer_nome: '00020101021226910014BR.GOV.BCB.PIX',
            },
          },
        },
      }),
    };
    const gateway = new PayPalGateway(client as any);

    const resultado = await gateway.createCheckout(
      { ...request, paymentMethod: PaymentMethod.PIX },
      comPix,
    );

    expect(resultado.pix?.code).toBe('00020101021226910014BR.GOV.BCB.PIX');
  });

  it('pedido que volta sem o código é recusado, sem abrir um QR vazio', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'ORDER-PIX',
        payment_source: {
          // CPF com cara de BR Code: a busca fica só nos campos do QR
          pix: { tax_info: { tax_id: '00020112345' }, qr_details: {} },
        },
      }),
    };
    const gateway = new PayPalGateway(client as any);

    await expect(
      gateway.createCheckout(
        { ...request, paymentMethod: PaymentMethod.PIX },
        comPix,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('sem a escolha, o pedido continua sendo o do checkout do PayPal', async () => {
    const client = {
      createOrder: jest.fn().mockResolvedValue({
        id: 'ORDER-1',
        links: [{ rel: 'payer-action', href: 'https://paypal/x' }],
      }),
    };
    const gateway = new PayPalGateway(client as any);

    const resultado = await gateway.createCheckout(request, comPix);
    const [payload] = client.createOrder.mock.calls[0];

    expect(payload.payment_source.pix).toBeUndefined();
    expect(payload.processing_instruction).toBeUndefined();
    // quem não tem conta PayPal (a maioria) cai direto no formulário de cartão
    expect(payload.payment_source.paypal.experience_context.landing_page).toBe(
      'GUEST_CHECKOUT',
    );
    expect(resultado.pix).toBeUndefined();
    expect(resultado.payUrl).toBe('https://paypal/x');
  });

  it('Pix pago volta como Pix; sem captura, a forma fica em aberto', async () => {
    const pix = (status: string, captura?: Record<string, unknown>) => ({
      ...pedido(status, captura),
      payment_source: { pix: {} },
    });
    const getOrder = jest
      .fn()
      .mockResolvedValueOnce(pix('COMPLETED', capturaPaga))
      .mockResolvedValueOnce(pix('PAYER_ACTION_REQUIRED'));
    const gateway = new PayPalGateway({ getOrder } as any);

    const [pago] = await gateway.listCharges('ref-1', comPix, 'ORDER-1');
    const [aguardando] = await gateway.listCharges('ref-1', comPix, 'ORDER-1');

    expect(pago).toMatchObject({
      status: PaymentStatus.PAID,
      method: PaymentMethod.PIX,
    });
    // "aguardando" com forma definida trava o botão de pagar na tela, e é
    // por ele que o inscrito volta ao QR
    expect(aguardando).toMatchObject({
      status: PaymentStatus.WAITING,
      method: PaymentMethod.OTHER,
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
      // pela conta PayPal: "conta digital", e não "outro", que no sistema
      // quer dizer forma ainda não definida
      method: PaymentMethod.WALLET,
      paidAmountCents: 12000,
      payload: { codeTransaction: 'CAP-1' },
    });
  });

  it('cartão sem login vira crédito ou débito, pelo que o PayPal informa', async () => {
    const comCartao = (type: string) => ({
      ...pedido('COMPLETED', capturaPaga),
      payment_source: { card: { type, brand: 'VISA', last_digits: '1234' } },
    });
    const gateway = new PayPalGateway(
      comPedidos(comCartao('CREDIT'), comCartao('DEBIT')) as any,
    );

    const [credito] = await gateway.listCharges('ref-1', ctx, 'ORDER-1');
    const [debito] = await gateway.listCharges('ref-1', ctx, 'ORDER-1');

    expect(credito.method).toBe(PaymentMethod.CREDIT_CARD);
    expect(debito.method).toBe(PaymentMethod.DEBIT_CARD);
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

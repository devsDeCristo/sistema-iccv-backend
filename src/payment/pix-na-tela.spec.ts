import { NotFoundException } from '@nestjs/common';
import {
  ChurchModule,
  CheckoutStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '@prisma/client';
import { PaymentService } from './payment.service';
import { GatewayResourceNotFoundError } from 'src/gateways/core/gateway.errors';
import { pixEstaticoComValor } from 'src/gateways/core/pix-estatico';

/**
 * O Pix do PayPal é o único pagamento que acontece numa tela nossa. Três
 * coisas não podem quebrar caladas: perguntar a forma antes de criar qualquer
 * coisa, não entregar o código de um inscrito a outro, e só dar baixa pelo
 * que o gateway responde.
 */
const gatewayResolvido = (
  formas: PaymentMethod[] | undefined,
  gateway: any = {},
) => ({
  gateway: {
    descriptor: { label: 'PayPal' },
    ...(formas && { paymentMethodChoices: () => formas }),
    ...gateway,
  },
  context: {},
  config: {
    id: 'config-1',
    provider: PaymentProvider.PAYPAL,
    churchId: 'ig-1',
  },
  webhookSecret: 'segredo',
});

const checkoutPix = (status: PaymentStatus = PaymentStatus.WAITING) => ({
  checkoutId: 'ORDER-1',
  referenceId: 'ref-1',
  provider: PaymentProvider.PAYPAL,
  configId: 'config-1',
  chargedAmountCents: 12000,
  pixCode: '00020101...',
  pixExpiresAt: new Date('2026-11-10T13:00:00Z'),
  status: CheckoutStatus.ACTIVE,
  payment: { status },
});

describe('createCheckout — escolha da forma de pagamento', () => {
  const prisma = () => ({
    event: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'ev-1',
        churchId: 'ig-1',
        name: 'Retiro',
        church: { plan: { modules: [ChurchModule.EVENTS] } },
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u-1' }) },
    payment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'p-1',
          status: PaymentStatus.WAITING,
          checkouts: [],
          eventUserRole: { role: { price: 120 }, discountPercent: null },
        },
      ]),
    },
    $transaction: jest.fn(),
  });

  const dto = {
    userId: 'u-1',
    eventId: 'ev-1',
    roleRegistrationId: ['r-1'],
  };

  it('devolve a pergunta, e não um link, antes de qualquer escrita', async () => {
    const banco = prisma();
    const createCheckout = jest.fn();
    const registry = {
      paraIgreja: jest.fn().mockResolvedValue(
        gatewayResolvido([PaymentMethod.PIX, PaymentMethod.CREDIT_CARD], {
          createCheckout,
        }),
      ),
    };
    const service = new PaymentService(banco as any, registry as any);

    const resposta: any = await service.createCheckout(dto);

    expect(resposta.link).toBeUndefined();
    expect(resposta.choice).toEqual({
      provider: PaymentProvider.PAYPAL,
      label: 'PayPal',
      methods: [PaymentMethod.PIX, PaymentMethod.CREDIT_CARD],
      // sem campo de formas no gateway falso, o nome genérico
      checkoutLabel: 'Outras formas',
      // sem repasse de taxa
      serviceFee: null,
      amountCents: 12000,
      // sem Pix estático configurado
      manualPix: false,
    });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(banco.$transaction).not.toHaveBeenCalled();
  });

  it('pergunta de novo quando a forma enviada não é uma das oferecidas', async () => {
    const registry = {
      paraIgreja: jest
        .fn()
        .mockResolvedValue(
          gatewayResolvido([PaymentMethod.PIX, PaymentMethod.CREDIT_CARD]),
        ),
    };
    const service = new PaymentService(prisma() as any, registry as any);

    const resposta: any = await service.createCheckout({
      ...dto,
      method: PaymentMethod.BOLETO,
    });

    expect(resposta.choice).toBeDefined();
  });

  it('gateway sem escolha segue direto, como sempre foi', async () => {
    const banco = prisma();
    // parar logo depois do ponto da pergunta basta: o que interessa é que
    // ela não foi feita
    banco.$transaction.mockRejectedValue(new Error('passou da pergunta'));
    const registry = {
      paraIgreja: jest.fn().mockResolvedValue(gatewayResolvido(undefined)),
    };
    const service = new PaymentService(banco as any, registry as any);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      service.createCheckout({ ...dto, method: PaymentMethod.PIX }),
    ).rejects.toThrow('passou da pergunta');
  });
});

describe('tela do QR — leitura e conferência', () => {
  const montar = (checkout: any, charges?: any[]) => {
    const findFirst = jest.fn().mockResolvedValue(checkout);
    const listCharges = jest.fn().mockResolvedValue(charges ?? []);
    const banco = {
      paymentCheckout: { findFirst },
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: 'Retiro', churchId: 'ig-1' }),
      },
    };
    const registry = {
      descriptor: () => ({ label: 'PayPal' }),
      porConfigId: jest
        .fn()
        .mockResolvedValue(gatewayResolvido(undefined, { listCharges })),
    };
    const service = new PaymentService(banco as any, registry as any);
    const baixa = jest
      .spyOn(service, 'updatePaymentWebhook')
      .mockResolvedValue(undefined as any);

    return { service, findFirst, listCharges, baixa };
  };

  it('só entrega o código ao inscrito e ao evento da rota', async () => {
    const { service, findFirst } = montar(checkoutPix());

    const tela = await service.pixDoCheckout('ev-1', 'u-1', 'ref-1');

    // o recorte está na consulta: referência de outra pessoa não é achada
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          referenceId: 'ref-1',
          pixCode: { not: null },
          payment: { userId: 'u-1', eventId: 'ev-1' },
        },
      }),
    );
    expect(tela).toMatchObject({
      code: '00020101...',
      amountCents: 12000,
      status: PaymentStatus.WAITING,
      active: true,
      providerLabel: 'PayPal',
    });
  });

  it('responde 404 para referência que não é deste inscrito', async () => {
    const { service } = montar(null);

    await expect(
      service.pixDoCheckout('ev-1', 'u-outro', 'ref-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('"já paguei" dá baixa pelo que o gateway responde, com o valor', async () => {
    const { service, listCharges, baixa } = montar(checkoutPix(), [
      {
        status: PaymentStatus.PAID,
        method: PaymentMethod.PIX,
        createdAt: new Date(),
        paidAmountCents: 12000,
        payload: { codeTransaction: 'CAP-1' },
      },
    ]);

    await service.conferirPix('ev-1', 'u-1', 'ref-1');

    expect(listCharges).toHaveBeenCalledWith('ref-1', {}, 'ORDER-1');
    // mesmo caminho do aviso do gateway: é ele que confere o valor pago
    expect(baixa).toHaveBeenCalledWith(
      'ref-1',
      PaymentStatus.PAID,
      PaymentMethod.PIX,
      { codeTransaction: 'CAP-1' },
      {
        provider: PaymentProvider.PAYPAL,
        configId: 'config-1',
        churchId: 'ig-1',
      },
      12000,
    );
  });

  // Cada teste com a sua referência: o intervalo entre conferências é por
  // referência e vive no processo, então reusar 'ref-1' faria o teste passar
  // sem o gateway ter sido consultado.
  it('"já paguei" sem pagamento no gateway não mexe na cobrança', async () => {
    const { service, baixa, listCharges } = montar(checkoutPix(), [
      {
        status: PaymentStatus.WAITING,
        method: PaymentMethod.OTHER,
        createdAt: new Date(),
        payload: {},
      },
    ]);

    await service.conferirPix('ev-1', 'u-1', 'ref-aguardando');

    expect(listCharges).toHaveBeenCalled();
    expect(baixa).not.toHaveBeenCalled();
  });

  it('cobrança já paga não volta a consultar o gateway', async () => {
    const { service, listCharges } = montar(checkoutPix(PaymentStatus.PAID));

    await service.conferirPix('ev-1', 'u-1', 'ref-ja-paga');

    expect(listCharges).not.toHaveBeenCalled();
  });

  it('cliques seguidos em "já paguei" consultam o gateway uma vez só', async () => {
    const { service, listCharges } = montar(checkoutPix(), [
      {
        status: PaymentStatus.WAITING,
        method: PaymentMethod.OTHER,
        createdAt: new Date(),
        payload: {},
      },
    ]);

    // a conta PayPal da igreja tem limite de chamadas: insistir no botão não
    // pode esgotá-lo para as baixas dos outros inscritos
    await service.conferirPix('ev-1', 'u-1', 'ref-insistente');
    await service.conferirPix('ev-1', 'u-1', 'ref-insistente');
    await service.conferirPix('ev-1', 'u-1', 'ref-insistente');

    expect(listCharges).toHaveBeenCalledTimes(1);
  });
});

/**
 * A auditoria confere o extrato de cada gateway contra as baixas dele. Para
 * isso a cobrança precisa dizer por qual gateway o dinheiro entrou — o do
 * checkout que respondeu, não o que a igreja usa hoje.
 */
describe('baixa pelo gateway grava qual gateway foi', () => {
  it('o aviso do gateway carimba o gateway do checkout na cobrança', async () => {
    const updateMany = jest.fn();
    const tx = {
      paymentCheckout: {
        findMany: jest.fn().mockResolvedValue([
          {
            provider: PaymentProvider.PAYPAL,
            chargedAmountCents: 1000,
            payment: { id: 'p-1', status: PaymentStatus.WAITING },
          },
        ]),
        updateMany: jest.fn(),
      },
      payment: { updateMany },
    };
    const banco = { $transaction: (fn: any) => fn(tx) };
    const service = new PaymentService(banco as any, {} as any);

    await service.updatePaymentWebhook(
      'ref-1',
      PaymentStatus.PAID,
      PaymentMethod.WALLET,
      { codeTransaction: 'CAP-1' },
      {
        provider: PaymentProvider.PAYPAL,
        configId: 'config-1',
        churchId: 'ig-1',
      },
      1000,
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentStatus.PAID,
          method: PaymentMethod.WALLET,
          provider: PaymentProvider.PAYPAL,
        }),
      }),
    );
  });
});

describe('lançamento manual não herda o gateway', () => {
  it('quitar à mão uma cobrança que o gateway tinha recusado limpa o gateway', async () => {
    const update = jest.fn();
    const tx = {
      payment: { findMany: jest.fn().mockResolvedValue([]), update },
      paymentCheckout: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
    };
    const banco = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p-1',
          eventId: 'ev-1',
          status: PaymentStatus.DECLINED,
          receivedFrom: 'SYSTEM',
          provider: PaymentProvider.PAYPAL,
          payload: {},
          roleRegistrationId: null,
          eventUserRole: null,
        }),
      },
      $transaction: (fn: any) => fn(tx),
    };
    const service = new PaymentService(banco as any, {} as any);

    await service.updatePaymentStatus('p-1', {
      status: PaymentStatus.PAID,
      method: PaymentMethod.CASH,
    } as any);

    // dinheiro na secretaria não é dinheiro do PayPal: a auditoria do extrato
    // do PayPal não pode contar com ele
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentStatus.PAID,
          receivedFrom: 'EXTERNAL',
          provider: null,
        }),
      }),
    );
  });
});

describe('forma do pedido', () => {
  // `formaDoPedido` decide também o reaproveitamento do checkout aberto: com
  // "nenhuma forma", o Pix já gerado não casava e cada clique fazia outro QR
  const { formaDoPedido } = jest.requireActual('./payment.service');

  it('a pedida, quando é uma das oferecidas', () => {
    const formas = [PaymentMethod.PIX, PaymentMethod.CREDIT_CARD];
    expect(formaDoPedido(formas, PaymentMethod.PIX)).toBe(PaymentMethod.PIX);
    expect(formaDoPedido(formas, PaymentMethod.BOLETO)).toBeUndefined();
    expect(formaDoPedido(formas)).toBeUndefined();
  });

  it('uma forma só é a forma do pedido, sem pergunta', () => {
    expect(formaDoPedido([PaymentMethod.PIX])).toBe(PaymentMethod.PIX);
  });

  it('gateway sem escolha não tem forma', () => {
    expect(formaDoPedido([], PaymentMethod.PIX)).toBeUndefined();
  });
});

describe('Pix aberto volta só se ainda estiver em vigor', () => {
  const ESTATICO =
    '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

  function montar(
    aberto: {
      checkoutId: string;
      pixCode: string;
      configId?: string;
      chargedAmountCents?: number;
    },
    credenciais: Record<string, string>,
    desconto: number | null = null,
  ) {
    const ativo = {
      referenceId: 'ref-antiga',
      provider: PaymentProvider.PAYPAL,
      configId: 'config-1',
      status: CheckoutStatus.ACTIVE,
      link: '/pix/antigo',
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      pixExpiresAt: new Date(Date.now() + 50 * 60 * 1000),
      // o ingresso de R$ 100, sem taxa
      chargedAmountCents: 10000,
      ...aberto,
    };
    const gateway = {
      descriptor: { label: 'PayPal', fields: [] },
      paymentMethodChoices: () => [
        PaymentMethod.PIX,
        PaymentMethod.CREDIT_CARD,
      ],
      listCharges: jest
        .fn()
        .mockRejectedValue(new GatewayResourceNotFoundError('PayPal', 'x')),
      // parar aqui basta: o que interessa é se um pedido novo foi pedido
      createCheckout: jest.fn().mockRejectedValue(new Error('pedido novo')),
    };
    const casa = {
      gateway,
      context: { credentials: credenciais },
      config: { id: 'config-1', provider: PaymentProvider.PAYPAL },
      webhookSecret: 's',
    };
    const prisma = {
      event: {
        findUnique: async () => ({
          id: 'ev-1',
          churchId: 'ig-1',
          name: 'Retiro',
          church: { plan: { modules: [ChurchModule.EVENTS] } },
        }),
      },
      user: {
        findUnique: async () => ({
          id: 'u-1',
          fullName: 'Fulano de Tal',
          cpf: '12345678909',
          cellphone: '55991234567',
        }),
      },
      payment: {
        findMany: async () => [
          {
            id: 'p-1',
            status: PaymentStatus.WAITING,
            checkouts: [ativo],
            productItems: [],
            eventUserRole: { role: { price: 100 }, discountPercent: desconto },
          },
        ],
        updateMany: async () => ({}),
      },
      paymentCheckout: { findMany: async () => [] },
      $transaction: async (fn: any) =>
        fn({
          payment: { findMany: async () => [], updateMany: async () => ({}) },
        }),
    };
    const registry = {
      paraIgreja: async () => casa,
      porConfigId: async () => casa,
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const service = new PaymentService(prisma as any, registry as any);
    const pagarComPix = () =>
      service.createCheckout({
        userId: 'u-1',
        eventId: 'ev-1',
        roleRegistrationId: ['r-1'],
        method: PaymentMethod.PIX,
      });
    return { gateway, pagarComPix };
  }

  const estaticoAberto = {
    checkoutId: 'PIX-ESTATICO-ref-antiga',
    pixCode: ESTATICO,
  };

  it('estático aberto e a igreja voltou ao Pix do PayPal: gera o do PayPal', async () => {
    const { gateway, pagarComPix } = montar(estaticoAberto, {});
    await expect(pagarComPix()).rejects.toThrow('pedido novo');
    expect(gateway.createCheckout).toHaveBeenCalled();
  });

  it('estático aberto com o mesmo código em vigor: reaproveita', async () => {
    const { gateway, pagarComPix } = montar(estaticoAberto, {
      staticPixCode: ESTATICO,
    });
    expect(await pagarComPix()).toEqual({
      message: 'Checkout already exists',
      link: '/pix/antigo',
    });
    expect(gateway.createCheckout).not.toHaveBeenCalled();
  });

  it('a igreja trocou o código colado: gera com o novo', async () => {
    const { gateway, pagarComPix } = montar(estaticoAberto, {
      staticPixCode: ESTATICO.replace('Fulano de Tal', 'Ciclano de Ta'),
    });
    await expect(pagarComPix()).rejects.toThrow('pedido novo');
    expect(gateway.createCheckout).toHaveBeenCalled();
  });

  it('Pix do PayPal aberto e a igreja ligou o estático: gera o estático', async () => {
    const { gateway, pagarComPix } = montar(
      { checkoutId: 'ORDER-1', pixCode: '00020101021226...' },
      { staticPixCode: ESTATICO },
    );
    await expect(pagarComPix()).rejects.toThrow('pedido novo');
    expect(gateway.createCheckout).toHaveBeenCalled();
  });

  it('estático aberto e a igreja ainda nele: reaproveita o que já tem valor', async () => {
    const { gateway, pagarComPix } = montar(
      {
        ...estaticoAberto,
        pixCode: pixEstaticoComValor(ESTATICO, 10000, 'FULANODETALREFA'),
      },
      { staticPixCode: ESTATICO },
    );
    expect((await pagarComPix()) as any).toMatchObject({
      link: '/pix/antigo',
    });
    expect(gateway.createCheckout).not.toHaveBeenCalled();
  });

  it('desconto dado depois de aberto: gera com o valor de agora', async () => {
    const { gateway, pagarComPix } = montar(
      estaticoAberto,
      { staticPixCode: ESTATICO },
      50,
    );
    await expect(pagarComPix()).rejects.toThrow('pedido novo');
    expect(gateway.createCheckout).toHaveBeenCalled();
  });

  it('taxa de serviço trocada depois de aberto: gera com a de agora', async () => {
    const { gateway, pagarComPix } = montar(
      { checkoutId: 'ORDER-1', pixCode: '000201...' },
      { serviceFees: 'PIX=0.99', enabledMethods: 'PIX,CREDIT_CARD' },
    );
    gateway.descriptor.fields = new (jest.requireActual(
      'src/gateways/paypal/paypal.gateway',
    ).PayPalGateway)({} as any).descriptor.fields;
    await expect(pagarComPix()).rejects.toThrow('pedido novo');
    expect(gateway.createCheckout).toHaveBeenCalled();
  });

  it('aberto em outra integração (a igreja trocou de gateway): gera na atual', async () => {
    const { gateway, pagarComPix } = montar(
      { checkoutId: 'ORDER-1', pixCode: '000201...', configId: 'config-velha' },
      {},
    );
    await expect(pagarComPix()).rejects.toThrow('pedido novo');
    expect(gateway.createCheckout).toHaveBeenCalled();
  });
});

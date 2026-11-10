import { NotFoundException } from '@nestjs/common';
import {
  ChurchModule,
  CheckoutStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '@prisma/client';
import { PaymentService } from './payment.service';

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
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'p-1', status: PaymentStatus.WAITING, checkouts: [] },
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

  it('"já paguei" sem pagamento no gateway não mexe na cobrança', async () => {
    const { service, baixa } = montar(checkoutPix(), [
      {
        status: PaymentStatus.WAITING,
        method: PaymentMethod.OTHER,
        createdAt: new Date(),
        payload: {},
      },
    ]);

    await service.conferirPix('ev-1', 'u-1', 'ref-1');

    expect(baixa).not.toHaveBeenCalled();
  });

  it('cobrança já paga não volta a consultar o gateway', async () => {
    const { service, listCharges } = montar(checkoutPix(PaymentStatus.PAID));

    await service.conferirPix('ev-1', 'u-1', 'ref-1');

    expect(listCharges).not.toHaveBeenCalled();
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ChurchModule,
  CheckoutStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '@prisma/client';
import { PaymentService } from './payment.service';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';

/**
 * O desconto da inscrição é o percentual escolhido no modal de pagamento
 * (0 a 100), e não mais um id da tabela `discounts`.
 */
describe('Desconto em percentual', () => {
  async function erros(discountPercent: unknown) {
    const dto = plainToInstance(UpdatePaymentStatusDto, {
      status: PaymentStatus.WAITING,
      discountPercent,
    });
    return { dto, erros: await validate(dto) };
  }

  it('aceita de 0 a 100, com decimal, vindo como texto do multipart', async () => {
    for (const valor of ['0', '15', '12.5', '100']) {
      const r = await erros(valor);
      expect(r.erros).toEqual([]);
      expect(r.dto.discountPercent).toBe(Number(valor));
    }
  });

  it('recusa fora do intervalo e o que não é número', async () => {
    for (const valor of ['-5', '150', 'abc', '10.123']) {
      expect((await erros(valor)).erros).not.toEqual([]);
    }
  });

  function montar() {
    const gravado: any[] = [];
    const tx = {
      payment: { update: async (args: any) => gravado.push(args.data) },
      paymentCheckout: {
        findMany: async () => [],
        updateMany: async () => ({}),
      },
    };
    const prisma = {
      payment: {
        findUnique: async () => ({
          id: 'p-1',
          status: PaymentStatus.WAITING,
          roleRegistrationId: 'r-1',
          eventId: 'ev-1',
          payload: {},
          eventUserRole: null,
        }),
      },
      $transaction: (fn: any) => fn(tx),
    };
    const service = new PaymentService(prisma as any, {} as any);
    // cancelado pula a reativação do estoque, que não é o assunto aqui
    const salvar = (discountPercent?: number) =>
      service.updatePaymentStatus('p-1', {
        status: PaymentStatus.CANCELED,
        method: PaymentMethod.PIX,
        discountPercent,
      } as any);

    return { gravado, salvar };
  }

  it('zero tira o desconto (antes escolher "Nenhum" não tirava)', async () => {
    const { gravado, salvar } = montar();
    await salvar(0);
    expect(gravado[0].eventUserRole).toEqual({
      update: { discountPercent: null },
    });
  });

  it('o percentual escolhido é gravado na inscrição', async () => {
    const { gravado, salvar } = montar();
    await salvar(12.5);
    expect(gravado[0].eventUserRole).toEqual({
      update: { discountPercent: 12.5 },
    });
  });

  it('ausente não mexe no desconto', async () => {
    const { gravado, salvar } = montar();
    await salvar(undefined);
    expect(gravado[0].eventUserRole).toBeUndefined();
  });

  describe('o valor a receber, na mesma conta da cobrança', () => {
    const { centavosACobrar } = jest.requireActual('./payment.service');

    it('ingresso + produtos, menos o desconto só sobre o ingresso', () => {
      expect(
        centavosACobrar([
          {
            eventUserRole: { discountPercent: 50, role: { price: 100 } },
            productItems: [{ unitPrice: 20, quantity: 2 }],
          },
        ]),
      ).toBe(9000); // 100 − 50 + 2 × 20
    });

    it('arredonda por item, como os itens da cobrança', () => {
      // 3 × 0,335 somado em reais e arredondado no fim dá 1,00; por item, 1,02
      expect(
        centavosACobrar([
          { productItems: [{ unitPrice: 0.335, quantity: 3 }] },
        ]),
      ).toBe(102);
    });

    it('compra avulsa sem ingresso e desconto de 100% não ficam negativos', () => {
      expect(
        centavosACobrar([
          { eventUserRole: { discountPercent: 100, role: { price: 80 } } },
        ]),
      ).toBe(0);
    });
  });
});

describe('Desconto de 100%: nada vai ao gateway', () => {
  const checkoutAntigo = {
    checkoutId: 'CHK-1',
    provider: PaymentProvider.TON,
    configId: 'config-1',
    status: CheckoutStatus.ACTIVE,
  };

  function montar(pagamento: Record<string, unknown>) {
    const gravado: any[] = [];
    const gateway = {
      descriptor: { label: 'Ton' },
      paymentMethodChoices: () => [
        PaymentMethod.PIX,
        PaymentMethod.CREDIT_CARD,
      ],
      createCheckout: jest.fn(),
      inactivateCheckout: jest.fn().mockResolvedValue(undefined),
    };
    const casa = {
      gateway,
      context: {},
      config: { id: 'config-1', provider: PaymentProvider.TON },
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
      user: { findUnique: async () => ({ id: 'u-1' }) },
      payment: {
        findMany: async () => [
          {
            id: 'p-1',
            status: PaymentStatus.WAITING,
            checkouts: [checkoutAntigo],
            productItems: [],
            ...pagamento,
          },
        ],
        updateMany: (args: any) => (gravado.push(args), args),
      },
      paymentCheckout: {
        updateMany: (args: any) => (gravado.push(args), args),
      },
      // a reativação de estoque (função) e a quitação (lista)
      $transaction: async (arg: any) =>
        typeof arg === 'function'
          ? arg({
              payment: {
                findMany: async () => [],
                updateMany: async () => ({}),
              },
            })
          : arg,
    };
    const registry = {
      paraIgreja: async () => casa,
      porConfigId: async () => casa,
    };
    const service = new PaymentService(prisma as any, registry as any);
    const pagar = () =>
      service.createCheckout({
        userId: 'u-1',
        eventId: 'ev-1',
        roleRegistrationId: ['r-1'],
      });
    return { gravado, gateway, pagar };
  }

  it('quita sem perguntar a forma e derruba a cobrança antiga', async () => {
    const { gravado, gateway, pagar } = montar({
      eventUserRole: { discountPercent: 100, role: { price: 80 } },
    });

    expect(await pagar()).toEqual({ message: 'paid by discount', paid: true });
    expect(gateway.createCheckout).not.toHaveBeenCalled();
    expect(gravado).toContainEqual({
      where: { paymentId: { in: ['p-1'] }, status: CheckoutStatus.ACTIVE },
      data: { status: CheckoutStatus.INACTIVE },
    });
    expect(gravado).toContainEqual({
      where: { id: { in: ['p-1'] } },
      data: { status: PaymentStatus.PAID, method: PaymentMethod.CASH },
    });
    await new Promise((r) => setImmediate(r));
    expect(gateway.inactivateCheckout).toHaveBeenCalledWith('CHK-1', {});
  });

  it('com produto pago junto ainda cobra: o desconto é só do ingresso', async () => {
    const { pagar } = montar({
      eventUserRole: { discountPercent: 100, role: { price: 80 } },
      productItems: [{ id: 'i-1', unitPrice: 30, quantity: 1 }],
    });

    expect(((await pagar()) as any).choice?.amountCents).toBe(3000);
  });
});

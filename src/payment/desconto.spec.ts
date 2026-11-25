import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
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

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
});

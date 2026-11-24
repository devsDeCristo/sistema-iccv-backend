import { PaymentReceived, PaymentStatus } from '@prisma/client';
import { PaymentService } from './payment.service';

/** O nome de quem marcou como pago, no modal de detalhes do pagamento. */
describe('Quem deu baixa manual', () => {
  const comQuemDeuBaixa = (PaymentService.prototype as any).comQuemDeuBaixa;

  function prisma(logs: any[]) {
    const consultas: any[] = [];
    return {
      consultas,
      paymentLog: {
        findMany: async (args: any) => (consultas.push(args.where), logs),
      },
      user: {
        findMany: async () => [{ id: 'adm-1', fullName: 'Ana Tesoureira' }],
      },
    };
  }

  it('nomeia quem passou para pago, só na baixa manual', async () => {
    const db = prisma([
      { paymentId: 'p-1', actorId: 'adm-1', createdAt: new Date('2026-11-20') },
    ]);

    const [manual, gateway] = await comQuemDeuBaixa.call({ prisma: db }, [
      {
        id: 'p-1',
        status: PaymentStatus.PAID,
        receivedFrom: PaymentReceived.EXTERNAL,
      },
      {
        id: 'p-2',
        status: PaymentStatus.PAID,
        receivedFrom: PaymentReceived.SYSTEM,
      },
    ]);

    expect(manual.paidBy).toMatchObject({
      id: 'adm-1',
      fullName: 'Ana Tesoureira',
    });
    expect(gateway.paidBy).toBeNull();
    // só o pagamento manual é consultado
    expect(db.consultas[0].paymentId).toEqual({ in: ['p-1'] });
  });

  it('a escrita pago → pago (entrega de produtos) não conta', async () => {
    const db = prisma([]);

    await comQuemDeuBaixa.call({ prisma: db }, [
      {
        id: 'p-1',
        status: PaymentStatus.PAID,
        receivedFrom: PaymentReceived.EXTERNAL,
      },
    ]);

    expect(db.consultas[0]).toMatchObject({
      statusAfter: PaymentStatus.PAID,
      OR: [
        { statusBefore: null },
        { statusBefore: { not: PaymentStatus.PAID } },
      ],
    });
  });

  it('sem baixa manual na página, nem consulta', async () => {
    const db = prisma([]);

    const [linha] = await comQuemDeuBaixa.call({ prisma: db }, [
      {
        id: 'p-1',
        status: PaymentStatus.WAITING,
        receivedFrom: PaymentReceived.PENDING,
      },
    ]);

    expect(linha.paidBy).toBeNull();
    expect(db.consultas).toEqual([]);
  });
});

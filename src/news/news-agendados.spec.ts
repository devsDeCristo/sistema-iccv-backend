import { NewsService } from './news.service';

/** horário de Brasília → instante UTC */
const brt = (iso: string) => new Date(`${iso}-03:00`);
const AGORA = brt('2026-10-06T12:00:30'); // terça

const semanal = (
  id: string,
  newsId: string,
  nextRunAt: Date,
  publicada = true,
) => ({
  id,
  newsId,
  kind: 'WEEKLY' as const,
  weekdays: [2],
  time: '12:00',
  runAt: null,
  nextRunAt,
  // publicada e já no ar; o teste da agendada sobrescreve `publishedAt`
  news: {
    id: newsId,
    isPublished: publicada,
    publishedAt: publicada ? brt('2026-10-01T10:00') : null,
  },
});

/**
 * O relógio dos agendamentos com o banco e o WhatsApp de dublê. `reservados`
 * diz quais agendamentos esta rodada consegue reservar (os outros já foram
 * pegos por uma rodada concorrente).
 */
function montar(vencidos: ReturnType<typeof semanal>[], reservados?: string[]) {
  const prisma = {
    newsSchedule: {
      findMany: jest.fn().mockResolvedValue(vencidos),
      updateMany: jest.fn(async ({ where }: any) => ({
        count: !reservados || reservados.includes(where.id) ? 1 : 0,
      })),
    },
    news: { update: jest.fn() },
  };
  const service = new NewsService(prisma as any, {} as any);
  const dispara = jest
    .spyOn(service as any, 'disparaNoWhatsapp')
    .mockResolvedValue({});

  return { service, prisma, dispara };
}

describe('NewsService — disparos agendados', () => {
  it('dispara para todos os grupos e marca a próxima terça', async () => {
    const { service, prisma, dispara } = montar([
      semanal('a1', 'n1', brt('2026-10-06T12:00')),
    ]);

    await service.dispararVencidos(AGORA);

    expect(dispara).toHaveBeenCalledWith('n1', 'SCHEDULE');
    expect(prisma.newsSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', nextRunAt: brt('2026-10-06T12:00') },
      data: { nextRunAt: brt('2026-10-13T12:00'), lastRunAt: AGORA },
    });
  });

  it('rodada concorrente que já reservou: não dispara de novo', async () => {
    const { service, dispara } = montar(
      [semanal('a1', 'n1', brt('2026-10-06T12:00'))],
      [],
    );

    await service.dispararVencidos(AGORA);

    expect(dispara).not.toHaveBeenCalled();
  });

  it('servidor ficou fora do ar: pula o disparo atrasado, mas reagenda', async () => {
    const { service, prisma, dispara } = montar([
      semanal('a1', 'n1', brt('2026-10-06T09:00')),
    ]);

    await service.dispararVencidos(AGORA);

    expect(dispara).not.toHaveBeenCalled();
    expect(prisma.newsSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nextRunAt: brt('2026-10-13T12:00') },
      }),
    );
  });

  it('rascunho fica parado: não publica nem envia, mas reagenda', async () => {
    const { service, prisma, dispara } = montar([
      semanal('a1', 'n1', brt('2026-10-06T12:00'), false),
    ]);

    await service.dispararVencidos(AGORA);

    expect(dispara).not.toHaveBeenCalled();
    expect(prisma.news.update).not.toHaveBeenCalled();
    expect(prisma.newsSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nextRunAt: brt('2026-10-13T12:00'), lastRunAt: AGORA },
      }),
    );
  });

  it('agendada que ainda não estava no ar: entra no mural e dispara', async () => {
    const agendada = semanal('a1', 'n1', brt('2026-10-06T12:00'));
    agendada.news.publishedAt = null;
    const { service, prisma, dispara } = montar([agendada]);

    await service.dispararVencidos(AGORA);

    expect(prisma.news.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { publishedAt: AGORA },
    });
    expect(dispara).toHaveBeenCalledWith('n1', 'SCHEDULE');
  });

  it('dois agendamentos da mesma notícia no mesmo minuto: sai uma vez', async () => {
    const { service, dispara } = montar([
      semanal('a1', 'n1', brt('2026-10-06T12:00')),
      semanal('a2', 'n1', brt('2026-10-06T12:00')),
    ]);

    await service.dispararVencidos(AGORA);

    expect(dispara).toHaveBeenCalledTimes(1);
  });
});

describe('NewsService — calendário', () => {
  it('"toda terça" vira uma entrada por terça do período', async () => {
    const noticia = { id: 'n1', title: 'Aviso' };
    const prisma = {
      newsDispatch: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'd1',
            newsId: 'n1',
            at: brt('2026-10-02T12:00'),
            news: noticia,
          },
        ]),
      },
      newsSchedule: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { ...semanal('a1', 'n1', brt('2026-10-06T12:00')), news: noticia },
          ]),
      },
    };
    const service = new NewsService(prisma as any, {} as any);

    const { feitos, agendados } = await service.calendar(
      brt('2026-10-01T00:00'),
      brt('2026-11-01T00:00'),
    );

    expect(feitos).toEqual([
      { id: 'd1', at: brt('2026-10-02T12:00'), news: noticia },
    ]);
    expect(agendados.map((a) => a.at)).toEqual([
      brt('2026-10-06T12:00'),
      brt('2026-10-13T12:00'),
      brt('2026-10-20T12:00'),
      brt('2026-10-27T12:00'),
    ]);
  });

  it('recusa período maior que 62 dias', async () => {
    const service = new NewsService({} as any, {} as any);
    await expect(
      service.calendar(brt('2026-01-01T00:00'), brt('2026-06-01T00:00')),
    ).rejects.toThrow('62 dias');
  });
});

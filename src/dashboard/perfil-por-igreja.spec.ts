import { Role } from '../auth/roles';
import { DashboardService } from './dashboard.service';

/**
 * Perfil por igreja na home: quem é admin na A e tesouraria na B não vê a B
 * como admin. As consultas pesadas são dublês — o que se confere aqui é qual
 * home sai e com qual recorte cada bloco é montado.
 */
const misto = {
  role: Role.ADMIN,
  churchRoles: [
    { churchId: 'A', role: Role.ADMIN },
    { churchId: 'B', role: Role.TESOURARIA },
  ],
};

const TUDO = ['EVENTS', 'NEWS'];

function montar(
  planos: Record<string, string[]> = { A: TUDO, B: TUDO },
  requester: object = misto,
) {
  const prisma = {
    user: { findUnique: () => Promise.resolve(requester) },
    church: {
      findUnique: ({ where }: any) => Promise.resolve({ id: where.id }),
      findMany: ({ where }: any) =>
        Promise.resolve(
          where.id.in.map((id: string) => ({
            id,
            plan: { modules: planos[id] ?? [] },
          })),
        ),
    },
  };
  const service = new DashboardService(prisma as any) as any;

  const espiao = (nome: string, valor: unknown) =>
    jest.spyOn(service, nome).mockResolvedValue(valor as never);

  const inscricoes = espiao('inscricoesRecentes', []);
  const mural = espiao('mural', { items: [], drafts: 0 });
  const tesouraria = espiao('tesouraria', { total: 0 });
  espiao('eventosAbertos', []);
  espiao('minhasIgrejas', []);
  espiao('eventosComSaldo', []);
  espiao('ultimoEncerrado', null);
  const resumo = espiao('resumoDasIgrejas', null);
  jest.spyOn(service, 'pendencias').mockReturnValue([] as never);

  return { service, inscricoes, mural, tesouraria, resumo };
}

describe('DashboardService — perfil por igreja', () => {
  it('abrindo a B, onde é tesouraria: home da tesouraria, sem mural nem inscrições', async () => {
    const { service, inscricoes, mural, tesouraria } = montar();

    const home = await service.overview('u', 'B');

    expect(home.role).toBe(Role.TESOURARIA);
    expect(tesouraria).toHaveBeenCalled();
    expect(inscricoes).not.toHaveBeenCalled();
    expect(mural).not.toHaveBeenCalled();
  });

  it('abrindo a A, onde é admin: home do admin', async () => {
    const { service, mural } = montar();

    const home = await service.overview('u', 'A');

    expect(home.role).toBe(Role.ADMIN);
    expect(mural).toHaveBeenCalledWith(['A']);
  });

  it('em todas: inscrições recentes e mural só das igrejas onde é admin', async () => {
    const { service, inscricoes, mural } = montar();

    await service.overview('u');

    expect(inscricoes).toHaveBeenCalledWith({ churchId: { in: ['A'] } });
    expect(mural).toHaveBeenCalledWith(['A']);
  });

  it('plano sem Notícias: sem mural; sem Eventos: sem eventos, inscrições nem caixa', async () => {
    const soEventos = montar({ A: ['EVENTS'], B: ['EVENTS'] });
    const home = await soEventos.service.overview('u', 'A');
    expect(soEventos.mural).not.toHaveBeenCalled();
    expect(home.news).toBeNull();
    expect(home.events).toEqual([]);

    const soNoticias = montar({ A: ['NEWS'], B: [] });
    const daA = await soNoticias.service.overview('u', 'A');
    expect(daA.events).toBeNull();
    expect(daA.recentRegistrations).toBeNull();
    expect(soNoticias.inscricoes).not.toHaveBeenCalled();
    expect(soNoticias.mural).toHaveBeenCalledWith(['A']);

    const daB = await soNoticias.service.overview('u', 'B');
    expect(daB.treasury).toBeNull();
    expect(soNoticias.tesouraria).not.toHaveBeenCalled();
  });

  it('resumo dos cards: cada módulo com as igrejas do plano e do perfil', async () => {
    const { service, resumo } = montar({
      A: ['EVENTS', 'NEWS'],
      B: ['TREASURY'],
    });

    await service.overview('u');

    expect(resumo).toHaveBeenCalledWith(expect.any(Array), {
      membros: ['A', 'B'],
      // pedidos de membro e notícias são do admin: só a A
      pedidos: ['A'],
      eventos: ['A'],
      noticias: ['A'],
      tesouraria: ['B'],
    });
  });

  it('super admin abrindo a home de uma igreja vê o plano dela, e não tudo', async () => {
    const superAdmin = { role: Role.SUPER_ADMIN, churchRoles: [] };
    const { service, mural, resumo } = montar({ B: ['EVENTS'] }, superAdmin);

    const home = await service.overview('u', 'B');

    expect(home.news).toBeNull();
    expect(mural).not.toHaveBeenCalled();
    expect(resumo).toHaveBeenCalledWith(
      [{ id: 'B', plan: { modules: ['EVENTS'] } }],
      expect.objectContaining({ eventos: ['B'], noticias: [], tesouraria: [] }),
    );
  });
});

import { Role } from '../auth/roles';
import { DashboardService } from './dashboard.service';

/**
 * Perfil por igreja na home: quem é admin na A e financeiro na B não vê a B
 * como admin. As consultas pesadas são dublês — o que se confere aqui é qual
 * home sai e com qual recorte cada bloco é montado.
 */
const misto = {
  role: Role.ADMIN,
  churchRoles: [
    { churchId: 'A', role: Role.ADMIN },
    { churchId: 'B', role: Role.FINANCE },
  ],
};

function montar() {
  const prisma = {
    user: { findUnique: () => Promise.resolve(misto) },
    church: {
      findUnique: ({ where }: any) => Promise.resolve({ id: where.id }),
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
  jest.spyOn(service, 'pendencias').mockReturnValue([] as never);

  return { service, inscricoes, mural, tesouraria };
}

describe('DashboardService — perfil por igreja', () => {
  it('abrindo a B, onde é financeiro: home do financeiro, sem mural nem inscrições', async () => {
    const { service, inscricoes, mural, tesouraria } = montar();

    const home = await service.overview('u', 'B');

    expect(home.role).toBe(Role.FINANCE);
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
});

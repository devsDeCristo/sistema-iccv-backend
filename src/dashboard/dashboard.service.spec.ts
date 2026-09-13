import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '../auth/roles';
import { DashboardService } from './dashboard.service';

/**
 * A home da igreja tem duas portas: o admin chega nela sem dizer nada, e o
 * super admin chega na de qualquer uma passando `churchId` — é o que a lista
 * de igrejas faz ao abrir uma linha.
 *
 * O `churchId` vem da barra de endereço, então ele é a fronteira: sem a
 * conferência, trocar o id na URL entregaria a qualquer admin o painel inteiro
 * de outra igreja — inscritos, caixa e mural. Foi medido contra o servidor de
 * verdade antes destes testes existirem: o admin da Igreja Padrão recebeu 200
 * com o painel da igreja Teste.
 *
 * Os testes param na conferência de propósito. Montar a resposta inteira
 * exigiria um Prisma de mentira com meia dúzia de consultas, e o que precisa
 * ficar fixo aqui é quem passa e quem não passa.
 */

const IGREJA_A = 'igreja-a';
const IGREJA_B = 'igreja-b';

const PESSOAS: Record<string, { role: number; churchRoles: any[] }> = {
  'admin-a': {
    role: Role.ADMIN,
    churchRoles: [{ churchId: IGREJA_A, role: Role.ADMIN }],
  },
  'financeiro-a': {
    role: Role.FINANCE,
    churchRoles: [{ churchId: IGREJA_A, role: Role.FINANCE }],
  },
  super: { role: Role.SUPER_ADMIN, churchRoles: [] },
  dev: { role: Role.DEV, churchRoles: [] },
};

function montar() {
  /** Igrejas conferidas, na ordem — o que prova até onde a chamada chegou. */
  const conferidas: string[] = [];

  const prisma = {
    user: {
      findUnique: ({ where }: any) => Promise.resolve(PESSOAS[where.id] ?? null),
    },
    church: {
      findUnique: ({ where }: any) => {
        conferidas.push(where.id);
        // nenhuma existe: a chamada morre aqui, logo depois da fronteira
        return Promise.resolve(null);
      },
    },
  };

  return {
    conferidas,
    service: new DashboardService(prisma as any),
  };
}

describe('DashboardService — a igreja pedida na URL', () => {
  it('barra o admin que pede a home de outra igreja', async () => {
    const { service, conferidas } = montar();

    await expect(service.overview('admin-a', IGREJA_B)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // e barra antes de ler qualquer coisa: nem a existência da igreja vaza
    expect(conferidas).toEqual([]);
  });

  it('barra o financeiro do mesmo jeito', async () => {
    const { service } = montar();

    await expect(
      service.overview('financeiro-a', IGREJA_B),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deixa o admin abrir a igreja dele', async () => {
    const { service, conferidas } = montar();

    await expect(service.overview('admin-a', IGREJA_A)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(conferidas).toEqual([IGREJA_A]);
  });

  it('deixa o super admin abrir qualquer uma — é assim que a lista de igrejas entra', async () => {
    const { service, conferidas } = montar();

    await expect(service.overview('super', IGREJA_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(conferidas).toEqual([IGREJA_B]);
  });

  it('o dev também, que é super admin com outro rótulo', async () => {
    const { service, conferidas } = montar();

    await expect(service.overview('dev', IGREJA_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(conferidas).toEqual([IGREJA_B]);
  });

  it('igreja que não existe é 404, e não um painel vazio', async () => {
    const { service } = montar();

    await expect(service.overview('super', 'nao-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('sem churchId ninguém confere igreja nenhuma: vale o vínculo de quem pediu', async () => {
    const { service, conferidas } = montar();

    // a resposta completa não é montada aqui (o Prisma de mentira não tem as
    // outras consultas); o que importa é que a fronteira do `churchId` não
    // entra em jogo quando ele não veio
    await service.overview('admin-a').catch(() => undefined);

    expect(conferidas).toEqual([]);
  });
});

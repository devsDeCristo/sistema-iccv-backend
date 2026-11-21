import { ROLES_KEY } from 'src/decorators/roles.decorator';
import { Role } from 'src/auth/roles';
import { SolicitacoesDaIgrejaController } from './solicitacoes.controller';
import { ChurchModule } from '@prisma/client';
import { SolicitacoesService } from './solicitacoes.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CriarSolicitacaoDto } from './solicitacoes.dto';

const ITENS = ['item-a', 'item-b', 'item-c'];

/** O banco de mentira do pedido: uma igreja e um membro dela */
function montar({
  igrejaDoMembro = { id: 'igreja-1', status: 'ACTIVE' } as any,
  modulos = [ChurchModule.REQUESTS] as ChurchModule[],
} = {}) {
  const criadas: any[] = [];
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ memberChurch: igrejaDoMembro })),
    },
    church: {
      findUnique: jest.fn(async () => ({
        name: 'Igreja Um',
        plan: { modules: modulos },
        modulePayment: true,
      })),
    },
    churchRequest: {
      create: jest.fn(async ({ data }: any) => {
        criadas.push(data);
        return data;
      }),
    },
  };
  return { service: new SolicitacoesService(prisma as any), criadas };
}

const pedido = {
  ministerio: 'Louvor',
  titulo: ' Microfones ',
  descricao: 'Quebraram',
  produtos: [
    {
      nome: ' Microfone sem fio ',
      quantidade: 2,
      link: 'https://loja.com/mic',
    },
    { nome: 'Cabo XLR', quantidade: 3 },
  ],
};

describe('SolicitacoesService', () => {
  it('pede para a igreja de que a pessoa é membro, com os produtos na ordem', async () => {
    const { service, criadas } = montar();
    await service.criar('u1', pedido);
    expect(criadas[0]).toMatchObject({
      churchId: 'igreja-1',
      requesterId: 'u1',
      title: 'Microfones',
    });
    expect(criadas[0].items.create).toEqual([
      {
        name: 'Microfone sem fio',
        quantity: 2,
        link: 'https://loja.com/mic',
        position: 0,
      },
      { name: 'Cabo XLR', quantity: 3, link: null, position: 1 },
    ]);
  });

  it('"Outro" grava qual é o ministério; os demais, não', async () => {
    const { service, criadas } = montar();
    await service.criar('membro-1', {
      ...pedido,
      ministerio: 'Outro',
      ministerioOutro: 'Teatro',
    });
    await service.criar('membro-1', { ...pedido, ministerioOutro: 'Teatro' });
    expect(criadas.map((c) => [c.ministry, c.ministryOther])).toEqual([
      ['Outro', 'Teatro'],
      ['Louvor', null],
    ]);
  });

  it('quem não é membro de nenhuma igreja não pede', async () => {
    const { service, criadas } = montar({ igrejaDoMembro: null });
    await expect(service.criar('u1', pedido)).rejects.toMatchObject({
      status: 403,
    });
    expect(criadas).toEqual([]);
  });

  it('igreja sem Solicitações no plano não recebe pedido', async () => {
    const { service, criadas } = montar({ modulos: [ChurchModule.EVENTS] });
    await expect(service.criar('u1', pedido)).rejects.toMatchObject({
      status: 403,
    });
    expect(criadas).toEqual([]);
  });
});

/**
 * O trâmite das duas confirmações, num banco em memória: uma solicitação de 3
 * produtos na igreja-1, com o pastor `pastor-1` e a tesouraria `tes-1` e
 * `tes-2`. `admin-1` é admin sem ser nenhum dos dois.
 */
function montarTramite({
  status = 'REQUESTED',
  pastorAprovou = null as string[] | null,
  tesourariaAprovou = null as string[] | null,
  lider = 'pastor-1' as string | null,
  /** a igreja tem o módulo Tesouraria no plano */
  comModulo = true,
  /** quem tem o perfil de tesouraria na igreja */
  tesoureiros = ['tes-1', 'tes-2'],
} = {}) {
  const estado: any = {
    status,
    pastorDecision: pastorAprovou ? true : null,
    treasuryDecision: tesourariaAprovou ? true : null,
    response: null,
  };
  const itens = ITENS.map((id) => ({
    id,
    pastorAccepted: pastorAprovou ? pastorAprovou.includes(id) : null,
    treasuryAccepted: tesourariaAprovou ? tesourariaAprovou.includes(id) : null,
    accepted: null as boolean | null,
  }));
  const churchRequest = {
    findFirst: jest.fn(async ({ where }: any) =>
      where.id === 'sol-1' && where.churchId === 'igreja-1'
        ? { ...estado, items: itens.map((item) => ({ ...item })) }
        : null,
    ),
    update: jest.fn(async ({ data }: any) => Object.assign(estado, data)),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const casa =
        where.id === 'sol-1' &&
        where.churchId === 'igreja-1' &&
        where.status.in.includes(estado.status);
      if (casa) Object.assign(estado, data);
      return { count: casa ? 1 : 0 };
    }),
    // a notificação do fim lê a solicitação; aqui ela não acha e não avisa
    findUnique: jest.fn(async () => null),
  };
  const tx = {
    $queryRaw: jest.fn(),
    churchRequest,
    churchRequestItem: {
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(
          itens.find((item) => item.id === where.id),
          data,
        ),
      ),
    },
  };
  const prisma = {
    church: {
      findUnique: jest.fn(async () => ({
        spiritualLeaderId: lider,
        plan: {
          modules: comModulo
            ? [ChurchModule.REQUESTS, ChurchModule.TREASURY]
            : [ChurchModule.REQUESTS],
        },
      })),
    },
    userChurchRole: {
      findMany: jest.fn(async ({ where }: any) =>
        where.role === Role.TESOURARIA
          ? tesoureiros.map((userId) => ({ userId }))
          : [],
      ),
    },
    churchRequest,
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const resultado = () =>
    Object.fromEntries(itens.map((item) => [item.id, item.accepted]));
  return {
    service: new SolicitacoesService(prisma as any),
    estado,
    itens,
    resultado,
  };
}

describe('SolicitacoesService.decidir — pastor e tesouraria', () => {
  it('só o pastor e a tesouraria da igreja decidem', async () => {
    const { service, estado } = montarTramite();
    await expect(
      service.decidir('igreja-1', 'sol-1', 'admin-1', { aprova: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect(estado.status).toBe('REQUESTED');
  });

  it('o pastor aprova primeiro: fica aguardando a tesouraria, sem resultado ainda', async () => {
    const { service, estado, itens, resultado } = montarTramite();
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', {
      aprova: true,
      produtosAceitos: ['item-a', 'item-b'],
    });
    expect(estado).toMatchObject({
      status: 'AWAITING_TREASURY',
      pastorDecision: true,
      pastorId: 'pastor-1',
    });
    expect(itens.map((item) => item.pastorAccepted)).toEqual([
      true,
      true,
      false,
    ]);
    expect(Object.values(resultado())).toEqual([null, null, null]);
  });

  it('a tesouraria aprova primeiro: fica aguardando o pastor', async () => {
    const { service, estado } = montarTramite();
    await service.decidir('igreja-1', 'sol-1', 'tes-2', { aprova: true });
    expect(estado).toMatchObject({
      status: 'AWAITING_PASTOR',
      treasuryDecision: true,
      treasurerId: 'tes-2',
    });
  });

  it('o segundo fecha com o que os dois aprovaram em comum', async () => {
    const { service, estado, resultado } = montarTramite({
      status: 'AWAITING_TREASURY',
      pastorAprovou: ['item-a', 'item-b'],
    });
    await service.decidir('igreja-1', 'sol-1', 'tes-1', {
      aprova: true,
      produtosAceitos: ['item-b', 'item-c'],
    });
    expect(estado.status).toBe('PARTIALLY_ACCEPTED');
    expect(resultado()).toEqual({
      'item-a': false,
      'item-b': true,
      'item-c': false,
    });
  });

  it('os dois aprovando tudo: aceita', async () => {
    const { service, estado, resultado } = montarTramite({
      status: 'AWAITING_PASTOR',
      tesourariaAprovou: ITENS,
    });
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', { aprova: true });
    expect(estado.status).toBe('ACCEPTED');
    expect(Object.values(resultado())).toEqual([true, true, true]);
  });

  it('aprovações sem nenhum produto em comum: recusada', async () => {
    const { service, estado } = montarTramite({
      status: 'AWAITING_TREASURY',
      pastorAprovou: ['item-a'],
    });
    await service.decidir('igreja-1', 'sol-1', 'tes-1', {
      aprova: true,
      produtosAceitos: ['item-c'],
    });
    expect(estado.status).toBe('REJECTED');
  });

  it('basta um recusar, mesmo com o outro já tendo aprovado', async () => {
    const { service, estado, resultado } = montarTramite({
      status: 'AWAITING_PASTOR',
      tesourariaAprovou: ITENS,
    });
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', {
      aprova: false,
      resposta: ' Sem verba este mês ',
    });
    expect(estado).toMatchObject({
      status: 'REJECTED',
      pastorDecision: false,
      response: 'Sem verba este mês',
    });
    expect(Object.values(resultado())).toEqual([false, false, false]);
  });

  it('cada lado decide uma vez — da tesouraria, basta uma pessoa', async () => {
    const { service } = montarTramite({
      status: 'AWAITING_PASTOR',
      tesourariaAprovou: ITENS,
    });
    await expect(
      service.decidir('igreja-1', 'sol-1', 'tes-2', {
        aprova: false,
        resposta: 'Sem verba',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('recusar pede o motivo', async () => {
    const { service, estado } = montarTramite();
    for (const resposta of [undefined, '   ']) {
      await expect(
        service.decidir('igreja-1', 'sol-1', 'pastor-1', {
          aprova: false,
          resposta,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(estado.status).toBe('REQUESTED');
  });

  it('decidida não volta a ser decidida', async () => {
    const { service } = montarTramite({ status: 'ACCEPTED' });
    await expect(
      service.decidir('igreja-1', 'sol-1', 'pastor-1', {
        aprova: false,
        resposta: 'Sem verba',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('aprovar pede ao menos um produto, e só deste pedido', async () => {
    const { service, estado } = montarTramite();
    for (const produtosAceitos of [[], ['item-a', 'de-outro-pedido']]) {
      await expect(
        service.decidir('igreja-1', 'sol-1', 'pastor-1', {
          aprova: true,
          produtosAceitos,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(estado.status).toBe('REQUESTED');
  });

  it('solicitação de outra igreja não existe para esta', async () => {
    const { service } = montarTramite();
    await expect(
      service.decidir('igreja-1', 'sol-2', 'pastor-1', { aprova: true }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('SolicitacoesService.decidir — quando a tesouraria entra no trâmite', () => {
  const soPastor = { comModulo: false, tesoureiros: [] as string[] };

  it('sem o módulo e sem ninguém na tesouraria, o pastor decide sozinho', async () => {
    const { service, estado, resultado } = montarTramite(soPastor);
    expect(await service.papel('igreja-1', 'pastor-1')).toEqual({
      lado: 'PASTOR',
      temPastor: true,
      temTesouraria: false,
      exigeTesouraria: false,
    });
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', { aprova: true });
    expect(estado.status).toBe('ACCEPTED');
    expect(resultado()).toEqual({
      'item-a': true,
      'item-b': true,
      'item-c': true,
    });
  });

  it('sozinho, aprovar parte fecha aceita em parte', async () => {
    const { service, estado, resultado } = montarTramite(soPastor);
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', {
      aprova: true,
      produtosAceitos: ['item-a'],
    });
    expect(estado.status).toBe('PARTIALLY_ACCEPTED');
    expect(resultado()).toEqual({
      'item-a': true,
      'item-b': false,
      'item-c': false,
    });
  });

  it('sem o módulo, mas com alguém na tesouraria: ela segue no trâmite', async () => {
    const { service, estado } = montarTramite({ comModulo: false });
    expect(await service.papel('igreja-1', 'tes-1')).toMatchObject({
      lado: 'TESOURARIA',
      exigeTesouraria: true,
    });
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', { aprova: true });
    expect(estado.status).toBe('AWAITING_TREASURY');
  });

  it('com o módulo e ninguém na tesouraria: segue exigida, e a tela é avisada', async () => {
    const { service, estado } = montarTramite({ tesoureiros: [] });
    expect(await service.papel('igreja-1', 'pastor-1')).toMatchObject({
      temTesouraria: false,
      exigeTesouraria: true,
    });
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', { aprova: true });
    expect(estado.status).toBe('AWAITING_TREASURY');
  });

  it('a aprovação da tesouraria de antes não conta quando ela sai do trâmite', async () => {
    const { service, estado, resultado } = montarTramite({
      ...soPastor,
      status: 'AWAITING_PASTOR',
      tesourariaAprovou: ['item-a'],
    });
    await service.decidir('igreja-1', 'sol-1', 'pastor-1', { aprova: true });
    expect(estado.status).toBe('ACCEPTED');
    expect(resultado()['item-b']).toBe(true);
  });
});

describe('SolicitacoesService.mudarStatus — o que o admin faz à mão', () => {
  it('põe em análise enquanto ninguém decidiu', async () => {
    const { service, estado } = montarTramite();
    await service.mudarStatus('igreja-1', 'sol-1', { status: 'IN_REVIEW' });
    expect(estado.status).toBe('IN_REVIEW');
  });

  it('depois da primeira decisão, a situação não muda à mão; a resposta sim', async () => {
    const { service, estado } = montarTramite({
      status: 'AWAITING_TREASURY',
      pastorAprovou: ITENS,
    });
    await expect(
      service.mudarStatus('igreja-1', 'sol-1', { status: 'IN_REVIEW' }),
    ).rejects.toMatchObject({ status: 409 });
    await service.mudarStatus('igreja-1', 'sol-1', {
      resposta: ' Compra na semana que vem ',
    });
    expect(estado).toMatchObject({
      status: 'AWAITING_TREASURY',
      response: 'Compra na semana que vem',
    });
  });

  it('não sobrescreve a decisão que chegou entre a leitura e a gravação', async () => {
    const { service, estado } = montarTramite();
    const leitura = { ...estado, items: [] };
    // o pastor aprova logo depois de o admin ler "solicitada"
    estado.status = 'AWAITING_TREASURY';
    estado.pastorDecision = true;
    (service as any).prisma.churchRequest.findFirst.mockResolvedValueOnce(
      leitura,
    );
    await expect(
      service.mudarStatus('igreja-1', 'sol-1', { status: 'IN_REVIEW' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(estado.status).toBe('AWAITING_TREASURY');
  });

  it('não mexe em solicitação de outra igreja', async () => {
    const { service } = montarTramite();
    await expect(
      service.mudarStatus('igreja-2', 'sol-1', { status: 'IN_REVIEW' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('SolicitacoesService.daIgreja — a lista paginada do painel', () => {
  function montarLista(lider = 'pastor-1') {
    const churchRequest = {
      findMany: jest.fn<Promise<any>, [any]>(async () => [{ id: 'sol-1' }]),
      count: jest.fn(async () => 7),
      groupBy: jest.fn<Promise<any>, [any]>(async () => [
        { status: 'REQUESTED', _count: { _all: 2 } },
        { status: 'IN_REVIEW', _count: { _all: 1 } },
        { status: 'AWAITING_TREASURY', _count: { _all: 3 } },
        { status: 'REJECTED', _count: { _all: 4 } },
      ]),
    };
    const prisma = {
      church: {
        findUnique: jest.fn(async () => ({
          spiritualLeaderId: lider,
          plan: { modules: [ChurchModule.REQUESTS] },
        })),
      },
      userChurchRole: { findMany: jest.fn(async () => []) },
      churchRequest,
    };
    return { service: new SolicitacoesService(prisma as any), churchRequest };
  }

  it('pagina, filtra pela etapa e pelo ministério, e conta as abas', async () => {
    const { service, churchRequest } = montarLista();
    const lista = await service.daIgreja('igreja-1', 'pastor-1', {
      etapa: 'novas',
      ministerio: 'Louvor',
      page: 3,
      limit: 10,
    });
    expect(churchRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          churchId: 'igreja-1',
          ministry: 'Louvor',
          status: { in: ['REQUESTED', 'IN_REVIEW'] },
        },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 10,
      }),
    );
    // as contagens ignoram a etapa, mas seguem o filtro de ministério
    expect(churchRequest.groupBy.mock.calls[0][0].where).toEqual({
      churchId: 'igreja-1',
      ministry: 'Louvor',
    });
    expect(lista).toMatchObject({
      total: 7,
      page: 3,
      limit: 10,
      contagens: {
        todas: 10,
        novas: 3,
        'em-aprovacao': 3,
        aceitas: 0,
        recusadas: 4,
        'sua-vez': 7,
      },
    });
  });

  it('"Sua vez" do pastor: em aberto e sem a decisão dele', async () => {
    const { service, churchRequest } = montarLista();
    await service.daIgreja('igreja-1', 'pastor-1', { etapa: 'sua-vez' });
    expect(churchRequest.findMany.mock.calls[0][0].where).toEqual({
      churchId: 'igreja-1',
      status: { notIn: ['ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED'] },
      pastorDecision: null,
    });
  });

  it('quem não decide não tem vez', async () => {
    const { service, churchRequest } = montarLista();
    const lista = await service.daIgreja('igreja-1', 'admin-1', {
      etapa: 'sua-vez',
    });
    expect(churchRequest.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [] },
    });
    expect(lista.contagens['sua-vez']).toBe(0);
  });
});

describe('CriarSolicitacaoDto', () => {
  const erros = (dados: any) =>
    validate(plainToInstance(CriarSolicitacaoDto, dados)).then((lista) =>
      lista.map((erro) => erro.property),
    );

  it('texto só com espaços conta como vazio', async () => {
    expect(
      await erros({
        ...pedido,
        titulo: '   ',
        descricao: ' ',
        produtos: [{ nome: '  ', quantidade: 1 }],
      }),
    ).toEqual(expect.arrayContaining(['titulo', 'descricao', 'produtos']));
  });

  it('com "Outro", pede qual é o ministério', async () => {
    expect(await erros({ ...pedido, ministerio: 'Outro' })).toEqual([
      'ministerioOutro',
    ]);
    expect(
      await erros({ ...pedido, ministerio: 'Outro', ministerioOutro: '  ' }),
    ).toEqual(['ministerioOutro']);
    expect(
      await erros({
        ...pedido,
        ministerio: 'Outro',
        ministerioOutro: 'Teatro',
      }),
    ).toEqual([]);
  });

  it('apara as pontas e aceita o pedido', async () => {
    const dto = plainToInstance(CriarSolicitacaoDto, pedido);
    expect(await validate(dto)).toEqual([]);
    expect(dto.titulo).toBe('Microfones');
    expect(dto.produtos[0].nome).toBe('Microfone sem fio');
  });
});

describe('SolicitacoesDaIgrejaController', () => {
  it('o lado da igreja é do admin e da tesouraria dela', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      SolicitacoesDaIgrejaController,
    );
    expect(roles).toEqual(
      expect.arrayContaining([Role.ADMIN, Role.TESOURARIA]),
    );
    expect(roles).not.toContain(Role.USER);
  });
});

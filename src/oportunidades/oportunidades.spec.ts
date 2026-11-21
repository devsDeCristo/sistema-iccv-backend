import { ChurchModule } from '@prisma/client';
import { OportunidadesService } from './oportunidades.service';
import {
  formularioPadrao,
  normalizarFormulario,
  normalizarSalario,
  validarRespostas,
} from './formulario';
import * as bucket from './bucket';

jest.mock('./bucket', () => ({
  salvarNoBucket: jest.fn(),
  baixarDoBucket: jest.fn(),
  apagarDoBucket: jest.fn(),
}));

const VAGA = {
  id: 'vaga-1',
  churchId: 'igreja-1',
  status: 'APPROVED',
  proposedById: null as string | null,
  isOpen: true,
  closesAt: null as Date | null,
  data: {} as any,
  interests: [] as any[],
};

const PDF = {
  mimetype: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4 ...'),
  size: 100,
  originalname: 'meu-cv.pdf',
} as Express.Multer.File;

/** O banco de mentira: uma igreja, um membro dela e uma vaga */
function montar({
  igrejaDoMembro = { id: 'igreja-1', status: 'ACTIVE' } as any,
  modulos = [ChurchModule.OPPORTUNITIES] as ChurchModule[],
  vaga = VAGA as any,
} = {}) {
  const bate = (where: any) =>
    !!vaga &&
    Object.entries(where).every(
      ([chave, valor]) =>
        (valor !== null && typeof valor === 'object') || vaga[chave] === valor,
    );
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ memberChurch: igrejaDoMembro })),
      findMany: jest.fn(async () => []),
    },
    church: {
      findUnique: jest.fn(async () => ({
        name: 'Igreja Um',
        plan: { modules: modulos },
        modulePayment: true,
      })),
    },
    opportunity: {
      // todo campo simples do `where` tem que bater: vaga de outra igreja,
      // de outra pessoa ou noutra situação não é achada
      findFirst: jest.fn(async ({ where }: any) => (bate(where) ? vaga : null)),
      findUnique: jest.fn(
        async () =>
          vaga && {
            ...vaga,
            title: 'Caixa',
            company: 'Padaria',
            church: { status: 'ACTIVE', plan: { modules: modulos } },
          },
      ),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({
        ...data,
        id: 'nova',
        interests: [],
      })),
      update: jest.fn(async ({ data }: any) => ({ ...data, interests: [] })),
      updateMany: jest.fn(async ({ where }: any) => ({
        count: bate(where) ? 1 : 0,
      })),
      deleteMany: jest.fn(async ({ where }: any) => ({
        count: bate(where) ? 1 : 0,
      })),
      count: jest.fn(async () => 0),
      delete: jest.fn(),
    },
    userChurchRole: {
      findMany: jest.fn(async () => [{ userId: 'admin' }]),
    },
    notificationRecipient: { deleteMany: jest.fn() },
    opportunityInterest: {
      update: jest.fn(async ({ data }: any) => ({
        stage: data.stage ?? 'NEW',
        note: data.note ?? null,
        trackedAt: data.trackedAt,
      })),
      create: jest.fn(),
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(),
    },
    notification: { create: jest.fn() },
  };
  return { service: new OportunidadesService(prisma as any), prisma };
}

describe('OportunidadesService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('o membro se candidata na vaga aberta da igreja dele', async () => {
    const { service, prisma } = montar();
    await expect(service.interessar('u1', 'vaga-1')).resolves.toEqual({
      interessei: true,
    });
    expect(prisma.opportunityInterest.create).toHaveBeenCalledWith({
      data: { opportunityId: 'vaga-1', userId: 'u1', answers: {} },
    });
  });

  it('quem não é membro de nenhuma igreja não vê nem se candidata', async () => {
    const { service, prisma } = montar({ igrejaDoMembro: null });
    await expect(service.abertas('u1')).rejects.toMatchObject({ status: 403 });
    await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
      status: 403,
    });
    expect(prisma.opportunityInterest.create).not.toHaveBeenCalled();
  });

  it('membro de outra igreja não alcança a vaga (404)', async () => {
    const { service, prisma } = montar({
      igrejaDoMembro: { id: 'igreja-2', status: 'ACTIVE' },
    });
    await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.detalhe('u1', 'vaga-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.opportunityInterest.create).not.toHaveBeenCalled();
  });

  it('conta bloqueada cai fora mesmo com o token valendo (401)', async () => {
    const { service, prisma } = montar();
    prisma.user.findUnique.mockResolvedValue({
      memberChurch: { id: 'igreja-1', status: 'ACTIVE' },
      block: { userId: 'u1' },
    } as any);
    await expect(service.abertas('u1')).rejects.toMatchObject({ status: 401 });
    await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
      status: 401,
    });
    expect(prisma.opportunityInterest.create).not.toHaveBeenCalled();
  });

  it('membro de igreja desativada não vê as vagas dela', async () => {
    const { service } = montar({
      igrejaDoMembro: { id: 'igreja-1', status: 'INACTIVE' },
    });
    await expect(service.abertas('u1')).rejects.toMatchObject({ status: 403 });
  });

  it('o membro só alcança a vaga e o detalhe da própria igreja', async () => {
    const { service, prisma } = montar({
      igrejaDoMembro: { id: 'igreja-2', status: 'ACTIVE' },
    });
    await service.abertas('u1').catch(() => undefined);
    const { where } = (prisma.opportunity.findMany as jest.Mock).mock
      .calls[0][0];
    // a igreja da consulta é a do cadastro, nunca uma vinda da requisição
    expect(where.churchId).toBe('igreja-2');
  });

  it('o admin não baixa currículo nem troca imagem de vaga de outra igreja', async () => {
    const { service } = montar();
    await expect(
      service.trocarImagem('igreja-2', 'vaga-1', {} as any),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.removerImagem('igreja-2', 'vaga-1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(bucket.baixarDoBucket).not.toHaveBeenCalled();
  });

  it('a lista do painel é só da igreja da URL', async () => {
    const { service, prisma } = montar();
    await service.daIgreja('igreja-1');
    expect(
      (prisma.opportunity.findMany as jest.Mock).mock.calls[0][0].where,
    ).toEqual({ churchId: 'igreja-1' });
  });

  it('igreja sem Oportunidades no plano recusa', async () => {
    const { service } = montar({ modulos: [ChurchModule.EVENTS] });
    await expect(service.abertas('u1')).rejects.toMatchObject({ status: 403 });
  });

  it('vaga encerrada ou vencida não recebe candidatura', async () => {
    for (const vaga of [
      { ...VAGA, isOpen: false },
      { ...VAGA, closesAt: new Date(Date.now() - 1000) },
    ]) {
      const { service, prisma } = montar({ vaga });
      await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
        status: 409,
      });
      expect(prisma.opportunityInterest.create).not.toHaveBeenCalled();
    }
  });

  it('repetir a candidatura não duplica nem troca o enviado', async () => {
    const { service, prisma } = montar({
      vaga: { ...VAGA, interests: [{ userId: 'u1' }] },
    });
    await service.interessar('u1', 'vaga-1', '{}', PDF);
    expect(prisma.opportunityInterest.create).not.toHaveBeenCalled();
    expect(bucket.salvarNoBucket).not.toHaveBeenCalled();
  });

  it('o membro vê as que recebem candidatura e as encerradas em que se candidatou', async () => {
    const { service, prisma } = montar();
    await service.abertas('u1');
    const { where } = (prisma.opportunity.findMany as jest.Mock).mock
      .calls[0][0];
    expect(where.churchId).toBe('igreja-1');
    expect(where.OR[1]).toEqual({ interests: { some: { userId: 'u1' } } });
  });

  it('o currículo vai para um caminho privado e as respostas guardam o rótulo', async () => {
    const { service, prisma } = montar({
      vaga: {
        ...VAGA,
        data: {
          formulario: normalizarFormulario({
            campos: [
              { tipo: 'CURRICULO', obrigatorio: true },
              { tipo: 'REDE_SOCIAL', rede: 'linkedin' },
            ],
          }),
        },
      },
    });
    await service.interessar(
      'u1',
      'vaga-1',
      JSON.stringify({ 'rede-linkedin': 'linkedin.com/in/fulano' }),
      PDF,
    );
    const caminho = (bucket.salvarNoBucket as jest.Mock).mock.calls[0][0];
    expect(caminho).toMatch(/^oportunidades\/vaga-1\/curriculos\/u1-.+\.pdf$/);
    expect(prisma.opportunityInterest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        answers: {
          curriculo: {
            tipo: 'CURRICULO',
            rotulo: 'Currículo',
            valor: { caminho, nome: 'meu-cv.pdf' },
          },
          'rede-linkedin': {
            tipo: 'REDE_SOCIAL',
            rotulo: 'LinkedIn',
            valor: 'https://linkedin.com/in/fulano',
          },
        },
      }),
    });
  });

  it('currículo obrigatório que não veio, ou que não é PDF, recusa', async () => {
    const vaga = {
      ...VAGA,
      data: {
        formulario: normalizarFormulario({
          campos: [{ tipo: 'CURRICULO', obrigatorio: true }],
        }),
      },
    };
    const { service } = montar({ vaga });
    await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.interessar('u1', 'vaga-1', undefined, {
        ...PDF,
        buffer: Buffer.from('<html>'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(bucket.salvarNoBucket).not.toHaveBeenCalled();
  });

  it('retirar a candidatura apaga o currículo do bucket', async () => {
    const { service, prisma } = montar();
    prisma.opportunityInterest.findMany.mockResolvedValueOnce([
      {
        answers: {
          curriculo: { tipo: 'CURRICULO', valor: { caminho: 'c/1.pdf' } },
        },
      },
    ] as any);
    await service.desinteressar('u1', 'vaga-1');
    expect(bucket.apagarDoBucket).toHaveBeenCalledWith(['c/1.pdf']);
  });

  it('o admin não mexe na vaga de outra igreja trocando o id', async () => {
    const { service, prisma } = montar();
    await expect(
      service.atualizar('igreja-2', 'vaga-1', { aberta: false }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.excluir('igreja-2', 'vaga-1')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.curriculo('igreja-2', 'vaga-1', 'u1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.opportunity.update).not.toHaveBeenCalled();
    expect(prisma.opportunity.delete).not.toHaveBeenCalled();
  });

  it('encerrar muda só a situação', async () => {
    const { service, prisma } = montar();
    await service.atualizar('igreja-1', 'vaga-1', { aberta: false });
    expect(prisma.opportunity.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isOpen: false } }),
    );
  });

  it('vaga publicada (pelo super admin) em igreja sem o módulo não avisa ninguém', async () => {
    const { service, prisma } = montar({ modulos: [ChurchModule.EVENTS] });
    prisma.user.findMany.mockResolvedValue([{ id: 'membro' }] as any);
    await service.criar('igreja-1', 'super', {
      titulo: 'Caixa',
      empresa: 'Padaria',
      descricao: 'Balcão',
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('com o módulo no plano, os membros são avisados', async () => {
    const { service, prisma } = montar();
    prisma.user.findMany.mockResolvedValue([{ id: 'membro' }] as any);
    await service.criar('igreja-1', 'admin', {
      titulo: 'Caixa',
      empresa: 'Padaria',
      descricao: 'Balcão',
    });
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'OPPORTUNITY' }),
      }),
    );
  });

  it('a vaga nova nasce com o formulário padrão e avisa os membros', async () => {
    const { service, prisma } = montar();
    await service.criar('igreja-1', 'admin', {
      titulo: 'Caixa',
      empresa: 'Padaria',
      descricao: 'Balcão',
      encerraEm: '2026-12-31',
    });
    const { data } = (prisma.opportunity.create as jest.Mock).mock.calls[0][0];
    expect(data.data.formulario).toEqual(formularioPadrao());
    expect(data.closesAt.toISOString()).toBe('2027-01-01T02:59:59.999Z');
    expect(prisma.opportunity.findUnique).toHaveBeenCalled();
  });
});

describe('propostas de vaga dos membros', () => {
  beforeEach(() => jest.clearAllMocks());

  const PROPOSTA = {
    ...VAGA,
    id: 'prop-1',
    status: 'PENDING',
    proposedById: 'u1',
  };
  const DTO = { titulo: 'Caixa', empresa: 'Padaria', descricao: 'Balcão' };

  it('a proposta vai para a igreja do cadastro, pendente, e avisa os admins', async () => {
    const { service, prisma } = montar({
      igrejaDoMembro: { id: 'igreja-1', status: 'ACTIVE' },
    });
    // o aviso relê a proposta recém-criada
    prisma.opportunity.findUnique.mockResolvedValueOnce({
      title: 'Caixa',
      churchId: 'igreja-1',
      proposedById: 'u1',
      proposedBy: { fullName: 'Fulana' },
    } as any);
    await service.propor('u1', { ...DTO, aberta: false } as any);
    const { data } = (prisma.opportunity.create as jest.Mock).mock.calls[0][0];
    expect(data).toMatchObject({
      churchId: 'igreja-1',
      status: 'PENDING',
      proposedById: 'u1',
      createdById: 'u1',
      // `aberta` não é do membro: a proposta nasce aberta, o admin decide
      isOpen: true,
    });
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'OPPORTUNITY_PROPOSAL' }),
      }),
    );
  });

  it('quem não é membro (ou é de igreja sem o módulo) não propõe', async () => {
    for (const opcoes of [
      { igrejaDoMembro: null },
      { modulos: [ChurchModule.EVENTS] },
    ]) {
      const { service, prisma } = montar(opcoes as any);
      await expect(service.propor('u1', DTO)).rejects.toMatchObject({
        status: 403,
      });
      expect(prisma.opportunity.create).not.toHaveBeenCalled();
    }
  });

  it('no máximo 5 propostas esperando ao mesmo tempo', async () => {
    const { service, prisma } = montar();
    prisma.opportunity.count.mockResolvedValue(5);
    await expect(service.propor('u1', DTO)).rejects.toMatchObject({
      status: 409,
    });
    expect(prisma.opportunity.create).not.toHaveBeenCalled();
  });

  it('a descrição é limpa: script some, e só script não é descrição', async () => {
    const { service, prisma } = montar();
    await service.propor('u1', {
      ...DTO,
      descricao: '<p>Oi<img src=x onerror=alert(1)></p><script>x()</script>',
    });
    const { data } = (prisma.opportunity.create as jest.Mock).mock.calls[0][0];
    expect(data.description).toBe('<p>Oi</p>');
    await expect(
      service.propor('u1', { ...DTO, descricao: '<script>x()</script>' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('a proposta pendente ou recusada não aparece nem recebe candidatura', async () => {
    for (const status of ['PENDING', 'REJECTED']) {
      const { service, prisma } = montar({ vaga: { ...VAGA, status } });
      await expect(service.detalhe('u2', 'vaga-1')).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.interessar('u2', 'vaga-1')).rejects.toMatchObject({
        status: 404,
      });
      expect(prisma.opportunityInterest.create).not.toHaveBeenCalled();
    }
    const { service, prisma } = montar();
    await service.abertas('u2');
    const { where } = (prisma.opportunity.findMany as jest.Mock).mock
      .calls[0][0];
    expect(where.status).toBe('APPROVED');
  });

  it('quem propôs edita a pendente; aberta não é dele', async () => {
    const { service, prisma } = montar({ vaga: PROPOSTA });
    await service.editarProposta('u1', 'prop-1', {
      titulo: 'Caixa II',
      aberta: false,
    });
    const chamada = (prisma.opportunity.updateMany as jest.Mock).mock
      .calls[0][0];
    expect(chamada.where).toMatchObject({
      id: 'prop-1',
      proposedById: 'u1',
      status: 'PENDING',
    });
    expect(chamada.data).toEqual({ title: 'Caixa II' });
  });

  it('ninguém mexe na proposta de outra pessoa, nem na já decidida', async () => {
    const { service } = montar({ vaga: PROPOSTA });
    await expect(
      service.editarProposta('u2', 'prop-1', { titulo: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.retirarProposta('u2', 'prop-1')).rejects.toMatchObject(
      { status: 404 },
    );

    const aprovada = montar({ vaga: { ...PROPOSTA, status: 'APPROVED' } });
    await expect(
      aprovada.service.editarProposta('u1', 'prop-1', { titulo: 'x' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      aprovada.service.retirarProposta('u1', 'prop-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(aprovada.prisma.opportunity.updateMany).not.toHaveBeenCalled();
    expect(aprovada.prisma.opportunity.deleteMany).not.toHaveBeenCalled();
  });

  it('proposta de outra igreja (de antes de mudar) não é alcançada', async () => {
    const { service } = montar({
      igrejaDoMembro: { id: 'igreja-2', status: 'ACTIVE' },
      vaga: PROPOSTA,
    });
    await expect(
      service.editarProposta('u1', 'prop-1', { titulo: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('o admin decidindo no meio: a edição e a retirada levam 409', async () => {
    const { service, prisma } = montar({ vaga: PROPOSTA });
    prisma.opportunity.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.editarProposta('u1', 'prop-1', { titulo: 'x' }),
    ).rejects.toMatchObject({ status: 409 });
    prisma.opportunity.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.retirarProposta('u1', 'prop-1')).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it('o admin aprova só a pendente, numa instrução só', async () => {
    const { service, prisma } = montar({ vaga: PROPOSTA });
    prisma.opportunity.findFirst.mockResolvedValueOnce(PROPOSTA as any);
    await service.aprovar('igreja-1', 'prop-1', 'admin');
    const chamada = (prisma.opportunity.updateMany as jest.Mock).mock
      .calls[0][0];
    expect(chamada.where).toEqual({
      id: 'prop-1',
      churchId: 'igreja-1',
      status: 'PENDING',
    });
    expect(chamada.data).toMatchObject({
      status: 'APPROVED',
      reviewedById: 'admin',
    });
    // o aviso "nova proposta" sai do sininho dos admins
    expect(prisma.notificationRecipient.deleteMany).toHaveBeenCalled();
  });

  it('dois admins decidindo juntos: o segundo leva 409', async () => {
    const { service, prisma } = montar({ vaga: PROPOSTA });
    prisma.opportunity.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.recusar('igreja-1', 'prop-1', 'admin', 'Já preenchida'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a recusa grava o motivo; admin de outra igreja não decide', async () => {
    const { service, prisma } = montar({ vaga: PROPOSTA });
    prisma.opportunity.findFirst.mockResolvedValueOnce(PROPOSTA as any);
    await service.recusar('igreja-1', 'prop-1', 'admin', '  Já preenchida ');
    expect(
      (prisma.opportunity.updateMany as jest.Mock).mock.calls[0][0].data,
    ).toMatchObject({ status: 'REJECTED', rejectionReason: 'Já preenchida' });

    const outra = montar({ vaga: PROPOSTA });
    await expect(
      outra.service.aprovar('igreja-2', 'prop-1', 'admin'),
    ).rejects.toMatchObject({ status: 404 });
    expect(outra.prisma.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it('quem propôs baixa o currículo só da vaga dele, aprovada', async () => {
    const aprovada = { ...PROPOSTA, status: 'APPROVED' };
    const { service } = montar({ vaga: aprovada });
    await expect(
      service.curriculoDaProposta('u2', 'prop-1', 'cand'),
    ).rejects.toMatchObject({ status: 404 });

    const pendente = montar({ vaga: PROPOSTA });
    await expect(
      pendente.service.curriculoDaProposta('u1', 'prop-1', 'cand'),
    ).rejects.toMatchObject({ status: 409 });
    expect(bucket.baixarDoBucket).not.toHaveBeenCalled();
  });

  it('a pendente não leva candidatos na lista de quem propôs', async () => {
    const { service, prisma } = montar();
    prisma.opportunity.findMany.mockResolvedValueOnce([
      { ...PROPOSTA, interests: [{ answers: {}, user: { id: 'x' } }] },
    ] as any);
    const [proposta] = await service.minhasPropostas('u1');
    expect(proposta.interests).toEqual([]);
    expect(
      (prisma.opportunity.findMany as jest.Mock).mock.calls[0][0].where,
    ).toEqual({ churchId: 'igreja-1', proposedById: 'u1' });
  });
});

describe('acompanhamento das candidaturas (etapa e anotação)', () => {
  beforeEach(() => jest.clearAllMocks());

  const APROVADA = {
    ...VAGA,
    id: 'prop-1',
    status: 'APPROVED',
    proposedById: 'u1',
  };

  it('o admin muda a etapa e a anotação; nota vazia apaga', async () => {
    const { service, prisma } = montar();
    await service.acompanharNoPainel('igreja-1', 'vaga-1', 'cand', {
      etapa: 'INTERVIEW' as any,
      nota: '  Entrevista sexta ',
    });
    const chamada = (prisma.opportunityInterest.update as jest.Mock).mock
      .calls[0][0];
    expect(chamada.where).toEqual({
      opportunityId_userId: { opportunityId: 'vaga-1', userId: 'cand' },
    });
    expect(chamada.data).toMatchObject({
      stage: 'INTERVIEW',
      note: 'Entrevista sexta',
    });

    await service.acompanharNoPainel('igreja-1', 'vaga-1', 'cand', {
      nota: '   ',
    });
    const segunda = (prisma.opportunityInterest.update as jest.Mock).mock
      .calls[1][0];
    expect(segunda.data.note).toBeNull();
    expect(segunda.data).not.toHaveProperty('stage');
  });

  it('admin de outra igreja não acompanha candidato de vaga alheia', async () => {
    const { service, prisma } = montar();
    await expect(
      service.acompanharNoPainel('igreja-2', 'vaga-1', 'cand', {
        etapa: 'SELECTED' as any,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.opportunityInterest.update).not.toHaveBeenCalled();
  });

  it('candidatura que não existe (ou foi retirada) é 404', async () => {
    const { service, prisma } = montar();
    prisma.opportunityInterest.update.mockRejectedValueOnce({
      code: 'P2025',
    });
    await expect(
      service.acompanharNoPainel('igreja-1', 'vaga-1', 'ninguem', {
        etapa: 'SELECTED' as any,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('quem propôs acompanha só a vaga dele, e só aprovada', async () => {
    const { service, prisma } = montar({ vaga: APROVADA });
    await service.acompanharNaProposta('u1', 'prop-1', 'cand', {
      etapa: 'REVIEWING' as any,
    });
    expect(prisma.opportunityInterest.update).toHaveBeenCalledTimes(1);

    await expect(
      service.acompanharNaProposta('u2', 'prop-1', 'cand', { nota: 'x' }),
    ).rejects.toMatchObject({ status: 404 });

    const pendente = montar({ vaga: { ...APROVADA, status: 'PENDING' } });
    await expect(
      pendente.service.acompanharNaProposta('u1', 'prop-1', 'cand', {
        nota: 'x',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(pendente.prisma.opportunityInterest.update).not.toHaveBeenCalled();
  });

  it('o candidato nunca recebe a etapa nem a anotação', async () => {
    const { service, prisma } = montar();
    await service.detalhe('u2', 'vaga-1').catch(() => undefined);
    const doDetalhe = (prisma.opportunity.findFirst as jest.Mock).mock
      .calls[0][0].select.interests.select;
    expect(Object.keys(doDetalhe).sort()).toEqual(['answers', 'createdAt']);

    await service.abertas('u2');
    const daLista = (prisma.opportunity.findMany as jest.Mock).mock.calls[0][0]
      .select.interests.select;
    expect(Object.keys(daLista)).toEqual(['createdAt']);
  });
});

describe('formulário de candidatura', () => {
  it('o padrão tem currículo, pretensão, mensagem e uma rede por campo', () => {
    expect(formularioPadrao().campos.map((c) => c.id)).toEqual([
      'curriculo',
      'pretensao_salarial',
      'mensagem',
      'rede-linkedin',
      'rede-instagram',
    ]);
  });

  it('campo padrão tem rótulo fixo e não se repete', () => {
    const { campos } = normalizarFormulario({
      campos: [{ tipo: 'MENSAGEM', rotulo: 'outro', obrigatorio: true }],
    });
    expect(campos[0]).toEqual({
      id: 'mensagem',
      tipo: 'MENSAGEM',
      rotulo: 'Mensagem',
      obrigatorio: true,
    });
    expect(() =>
      normalizarFormulario({
        campos: [
          { tipo: 'REDE_SOCIAL', rede: 'github' },
          { tipo: 'REDE_SOCIAL', rede: 'github' },
        ],
      }),
    ).toThrow();
  });

  it('pergunta de escolha pede ao menos 2 opções', () => {
    expect(() =>
      normalizarFormulario({
        campos: [{ tipo: 'SELECAO', rotulo: 'Turno', opcoes: ['Manhã'] }],
      }),
    ).toThrow();
  });

  it('confere as respostas pelo tipo de cada campo', () => {
    const formulario = normalizarFormulario({
      campos: [
        {
          id: 'turno',
          tipo: 'OPCAO_UNICA',
          rotulo: 'Turno',
          opcoes: ['Manhã', 'Tarde'],
          obrigatorio: true,
        },
        {
          id: 'dias',
          tipo: 'CAIXAS',
          rotulo: 'Dias',
          opcoes: ['Seg', 'Ter', 'Qua'],
        },
        { tipo: 'PRETENSAO_SALARIAL' },
        { tipo: 'REDE_SOCIAL', rede: 'instagram' },
      ],
    });
    const ok = validarRespostas(
      formulario,
      {
        turno: 'Tarde',
        dias: ['Qua', 'Seg'],
        pretensao_salarial: { min: 2000, max: 3000 },
      },
      false,
    );
    expect(ok.dias.valor).toEqual(['Seg', 'Qua']);
    expect(ok.pretensao_salarial.valor).toEqual({ min: 2000, max: 3000 });

    expect(() => validarRespostas(formulario, {}, false)).toThrow('Turno');
    expect(() =>
      validarRespostas(formulario, { turno: 'Noite' }, false),
    ).toThrow();
    expect(() =>
      validarRespostas(
        formulario,
        { turno: 'Manhã', 'rede-instagram': 'https://evil.com/x' },
        false,
      ),
    ).toThrow('Instagram');
  });

  it('salário: valor, faixa, e máximo menor que o mínimo recusa', () => {
    expect(normalizarSalario({ min: 1500 })).toEqual({ min: 1500 });
    expect(normalizarSalario({ min: '1500', max: '1500' })).toEqual({
      min: 1500,
    });
    expect(normalizarSalario({})).toBeNull();
    expect(() => normalizarSalario({ min: 3000, max: 2000 })).toThrow();
    expect(() => normalizarSalario({ min: -1 })).toThrow();
  });
});

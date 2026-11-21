import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChurchModule,
  ChurchRequestStatus,
  ChurchStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from 'src/auth/roles';
import { exigirModulo, modulosDa, SELECT_MODULOS } from 'src/planos/modulos';
import {
  notificarRespostaDaSolicitacao,
  notificarSolicitacao,
  notificarVezNaSolicitacao,
} from 'src/notificacoes/notificar';
import {
  CriarSolicitacaoDto,
  DecidirDto,
  ETAPAS,
  ListarSolicitacoesDto,
  MudarStatusDto,
  SUA_VEZ,
} from './solicitacoes.dto';

const CAMPOS = {
  id: true,
  ministry: true,
  ministryOther: true,
  title: true,
  description: true,
  status: true,
  response: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      name: true,
      quantity: true,
      link: true,
      accepted: true,
    },
  },
} as const;

/**
 * No painel, além do que o membro vê: quem pediu, as duas decisões (pastor e
 * tesouraria, com quem e quando) e o que cada um aprovou em cada produto.
 */
const CAMPOS_DA_IGREJA = {
  ...CAMPOS,
  pastorDecision: true,
  pastorAt: true,
  pastor: { select: { id: true, fullName: true } },
  treasuryDecision: true,
  treasuryAt: true,
  treasurer: { select: { id: true, fullName: true } },
  items: {
    orderBy: { position: 'asc' },
    select: {
      ...CAMPOS.items.select,
      pastorAccepted: true,
      treasuryAccepted: true,
    },
  },
  requester: {
    select: {
      id: true,
      fullName: true,
      profilePhotoUrl: true,
      cellphone: true,
    },
  },
} as const;

/** Ninguém decidiu ainda: o admin pode mexer na situação à mão */
const ANTES_DA_DECISAO: ChurchRequestStatus[] = [
  ChurchRequestStatus.REQUESTED,
  ChurchRequestStatus.IN_REVIEW,
];

/** O fim do trâmite: ninguém decide mais (a cancelada também) */
const DECIDIDA: ChurchRequestStatus[] = [
  ChurchRequestStatus.ACCEPTED,
  ChurchRequestStatus.PARTIALLY_ACCEPTED,
  ChurchRequestStatus.REJECTED,
  ChurchRequestStatus.CANCELED,
];

/** Quem decide: o pastor (líder espiritual da igreja) ou a tesouraria dela */
export type LadoDaDecisao = 'PASTOR' | 'TESOURARIA';

/**
 * Módulo Solicitações: o membro pede à igreja de que é membro (um ou mais
 * produtos). Aprovar pede duas confirmações, em qualquer ordem — a do pastor e
 * a de uma tesouraria da igreja —, e recusar basta uma (`decidir`). A
 * tesouraria só entra na igreja que tem o módulo Tesouraria no plano ou
 * alguém com o perfil de tesouraria: sem nenhum dos dois, o pastor decide
 * sozinho. O admin que não decide acompanha, põe em análise e responde ao
 * membro (`mudarStatus`).
 */
@Injectable()
export class SolicitacoesService {
  constructor(private readonly prisma: PrismaService) {}

  /** As solicitações que a pessoa fez, de qualquer igreja, as novas primeiro */
  minhas(userId: string) {
    return this.prisma.churchRequest.findMany({
      where: { requesterId: userId },
      orderBy: { createdAt: 'desc' },
      select: { ...CAMPOS, church: { select: { id: true, name: true } } },
    });
  }

  /**
   * A igreja é a de que a pessoa é membro agora, nunca uma vinda do pedido:
   * quem não é membro de nenhuma não pede, e ninguém pede para a igreja dos
   * outros.
   */
  async criar(userId: string, dto: CriarSolicitacaoDto) {
    const pessoa = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { memberChurch: { select: { id: true, status: true } } },
    });
    const igreja = pessoa?.memberChurch;
    if (!igreja || igreja.status === ChurchStatus.INACTIVE) {
      throw new ForbiddenException(
        'Só quem é membro de uma igreja faz solicitações a ela',
      );
    }
    await exigirModulo(this.prisma, igreja.id, ChurchModule.REQUESTS);

    const criada = await this.prisma.churchRequest.create({
      data: {
        churchId: igreja.id,
        requesterId: userId,
        ministry: dto.ministerio,
        ministryOther:
          dto.ministerio === 'Outro' ? dto.ministerioOutro ?? null : null,
        title: dto.titulo.trim(),
        description: dto.descricao.trim(),
        items: {
          create: dto.produtos.map((produto, posicao) => ({
            name: produto.nome.trim(),
            quantity: produto.quantidade,
            link: produto.link?.trim() || null,
            position: posicao,
          })),
        },
      },
      select: CAMPOS,
    });
    await notificarSolicitacao(this.prisma, criada.id);
    return criada;
  }

  /**
   * Quem pediu desiste: só a própria solicitação, e só antes de qualquer
   * decisão (solicitada ou em análise). Depois que o pastor ou a tesouraria
   * aprovou, o trâmite segue até o fim. A condição vai no `where`: uma
   * decisão que chegou no meio não é desfeita.
   */
  async cancelar(userId: string, id: string) {
    const { count } = await this.prisma.churchRequest.updateMany({
      where: { id, requesterId: userId, status: { in: ANTES_DA_DECISAO } },
      data: { status: ChurchRequestStatus.CANCELED },
    });
    if (!count) {
      const minha = await this.prisma.churchRequest.findFirst({
        where: { id, requesterId: userId },
        select: { id: true },
      });
      if (!minha) throw new NotFoundException('Solicitação não encontrada');
      throw new ConflictException(
        'Só dá para cancelar antes de o pastor ou a tesouraria decidir',
      );
    }
    return this.prisma.churchRequest.findUnique({
      where: { id },
      select: { ...CAMPOS, church: { select: { id: true, name: true } } },
    });
  }

  /**
   * As solicitações da igreja, com quem pediu e as decisões: uma página, as
   * novas primeiro (ou as antigas, `ordem: 'asc'`), da etapa e do ministério
   * pedidos. Junto, as contagens de cada aba, no mesmo filtro de ministério —
   * "Sua vez" é o que espera a decisão de quem está logado (`papel`).
   */
  async daIgreja(
    churchId: string,
    userId: string,
    dto: ListarSolicitacoesDto = {},
  ) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 25;
    const { lado } = await this.papel(churchId, userId);

    const base: Prisma.ChurchRequestWhereInput = {
      churchId,
      ...(dto.ministerio && { ministry: dto.ministerio }),
    };
    // em aberto, e o lado de quem está logado ainda não decidiu
    const daVez: Prisma.ChurchRequestWhereInput | null = lado
      ? {
          ...base,
          status: { notIn: DECIDIDA },
          ...(lado === 'PASTOR'
            ? { pastorDecision: null }
            : { treasuryDecision: null }),
        }
      : null;
    const where: Prisma.ChurchRequestWhereInput =
      dto.etapa === SUA_VEZ
        ? daVez ?? { id: { in: [] } }
        : dto.etapa
        ? { ...base, status: { in: ETAPAS[dto.etapa] } }
        : base;

    const [items, total, porSituacao, suaVez] = await Promise.all([
      this.prisma.churchRequest.findMany({
        where,
        orderBy: { createdAt: dto.ordem ?? 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: CAMPOS_DA_IGREJA,
      }),
      this.prisma.churchRequest.count({ where }),
      this.prisma.churchRequest.groupBy({
        by: ['status'],
        where: base,
        _count: { _all: true },
      }),
      daVez ? this.prisma.churchRequest.count({ where: daVez }) : 0,
    ]);

    const contar = (situacoes: ChurchRequestStatus[]) =>
      porSituacao
        .filter((grupo) => situacoes.includes(grupo.status))
        .reduce((soma, grupo) => soma + grupo._count._all, 0);
    const contagens = {
      todas: contar(Object.values(ChurchRequestStatus)),
      ...Object.fromEntries(
        Object.entries(ETAPAS).map(([etapa, situacoes]) => [
          etapa,
          contar(situacoes),
        ]),
      ),
      [SUA_VEZ]: suaVez,
    };

    return { items, total, page, limit, contagens };
  }

  /**
   * Como quem está logado decide nesta igreja: pastor (o líder espiritual,
   * `Church.spiritualLeaderId`), tesouraria (o vínculo dela aqui) ou nenhum.
   * `temPastor` avisa a tela da igreja sem pastor cadastrado, que não consegue
   * aprovar nada até cadastrarem um.
   *
   * `exigeTesouraria`: a aprovação pede a tesouraria — a igreja tem o módulo
   * Tesouraria no plano **ou** alguém com o perfil de tesouraria nela (o
   * perfil existe sem o módulo). Sem nenhum dos dois, o pastor decide
   * sozinho. `temTesouraria` avisa a tela da igreja com o módulo e sem
   * ninguém na tesouraria, que não consegue aprovar nada até cadastrarem um.
   */
  async papel(churchId: string, userId: string) {
    const [igreja, tesoureiros] = await Promise.all([
      this.prisma.church.findUnique({
        where: { id: churchId },
        select: { spiritualLeaderId: true, ...SELECT_MODULOS },
      }),
      this.prisma.userChurchRole.findMany({
        where: { churchId, role: Role.TESOURARIA },
        select: { userId: true },
      }),
    ]);
    const temTesouraria = tesoureiros.length > 0;
    const exigeTesouraria =
      temTesouraria || modulosDa(igreja).includes(ChurchModule.TREASURY);
    const lado: LadoDaDecisao | null =
      igreja?.spiritualLeaderId === userId
        ? 'PASTOR'
        : tesoureiros.some((t) => t.userId === userId)
        ? 'TESOURARIA'
        : null;
    return {
      lado,
      temPastor: !!igreja?.spiritualLeaderId,
      temTesouraria,
      exigeTesouraria,
    };
  }

  /**
   * A solicitação tem que ser desta igreja: o guard confere que a pessoa é do
   * painel da igreja da URL, e aqui se confere que o pedido é dela — senão
   * trocar o id bastava para mexer no pedido de outra igreja.
   *
   * À mão, só a situação de antes de qualquer decisão (solicitada ou em
   * análise) e a resposta ao membro. Depois que o pastor ou a tesouraria
   * decidiu, a situação anda só pela decisão deles; a resposta continua
   * editável.
   */
  async mudarStatus(
    churchId: string,
    id: string,
    dto: MudarStatusDto,
    actorId?: string,
  ) {
    const atual = await this.prisma.churchRequest.findFirst({
      where: { id, churchId },
      select: { status: true },
    });
    if (!atual) throw new NotFoundException('Solicitação não encontrada');

    const jaDecidida = new ConflictException(
      'A solicitação já está com o pastor e a tesouraria: a situação muda pela decisão deles',
    );
    const mudaSituacao = !!dto.status && dto.status !== atual.status;
    if (mudaSituacao && !ANTES_DA_DECISAO.includes(atual.status)) {
      throw jaDecidida;
    }
    const resposta =
      dto.resposta !== undefined
        ? { response: dto.resposta.trim() || null }
        : {};

    if (mudaSituacao) {
      // a condição vai no `where`, e não só na leitura acima: a decisão do
      // pastor ou da tesouraria que chegou no meio não é sobrescrita
      const { count } = await this.prisma.churchRequest.updateMany({
        where: { id, churchId, status: { in: ANTES_DA_DECISAO } },
        data: { status: dto.status, ...resposta },
      });
      if (!count) throw jaDecidida;
    }

    const salva = mudaSituacao
      ? await this.prisma.churchRequest.findUnique({
          where: { id },
          select: CAMPOS_DA_IGREJA,
        })
      : await this.prisma.churchRequest.update({
          where: { id },
          data: resposta,
          select: CAMPOS_DA_IGREJA,
        });
    // só quando a situação muda: corrigir a resposta não avisa de novo
    if (mudaSituacao) {
      await notificarRespostaDaSolicitacao(this.prisma, id, actorId);
    }
    return salva;
  }

  /**
   * A decisão do pastor ou da tesouraria — o lado sai de quem está logado
   * (`papel`), nunca do corpo. Cada lado decide uma vez (da tesouraria, basta
   * uma pessoa).
   *
   * Igreja sem o módulo Tesouraria e sem ninguém na tesouraria
   * (`exigeTesouraria` falso): só o pastor decide, e a decisão dele fecha a
   * solicitação — com o que ele aprovou. Uma aprovação da tesouraria de antes
   * (o módulo saiu, o último tesoureiro saiu) não conta mais.
   *
   * Recusar pede o motivo (`resposta`): é o que quem pediu lê.
   *
   * - Recusar encerra: a solicitação vai para recusada, com todos os produtos
   *   fora, decida o outro lado o que for.
   * - Aprovar marca os produtos que este lado aprova (ao menos um). Se o outro
   *   ainda não decidiu, a solicitação fica aguardando por ele; se já aprovou,
   *   fecha com o que os dois aprovaram em comum: todos, aceita; alguns,
   *   aceita em parte; nenhum em comum, recusada.
   *
   * A linha fica travada (`FOR UPDATE`) durante a decisão: pastor e tesouraria
   * aprovando ao mesmo tempo não deixam a solicitação presa em "aguardando",
   * cada um achando que o outro ainda não tinha decidido.
   */
  async decidir(churchId: string, id: string, userId: string, dto: DecidirDto) {
    const { lado, exigeTesouraria } = await this.papel(churchId, userId);
    if (!lado) {
      throw new ForbiddenException(
        exigeTesouraria
          ? 'Só o pastor e a tesouraria da igreja aprovam ou recusam'
          : 'Só o pastor da igreja aprova ou recusa',
      );
    }
    if (!dto.aprova && !dto.resposta?.trim()) {
      throw new BadRequestException(
        'Diga o motivo da recusa: é o que quem pediu vai ler',
      );
    }
    const pastor = lado === 'PASTOR';

    const salva = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "church_requests" WHERE id = ${id} FOR UPDATE`;
      const atual = await tx.churchRequest.findFirst({
        where: { id, churchId },
        select: {
          status: true,
          pastorDecision: true,
          treasuryDecision: true,
          items: {
            select: { id: true, pastorAccepted: true, treasuryAccepted: true },
          },
        },
      });
      if (!atual) throw new NotFoundException('Solicitação não encontrada');
      if (DECIDIDA.includes(atual.status)) {
        throw new ConflictException(
          atual.status === ChurchRequestStatus.CANCELED
            ? 'Quem pediu cancelou esta solicitação'
            : 'Esta solicitação já foi decidida',
        );
      }
      const minha = pastor ? atual.pastorDecision : atual.treasuryDecision;
      if (minha !== null) {
        throw new ConflictException(
          pastor
            ? 'O pastor já decidiu esta solicitação'
            : 'A tesouraria já decidiu esta solicitação',
        );
      }

      const ids = atual.items.map((item) => item.id);
      const meus = new Set(dto.aprova ? dto.produtosAceitos ?? ids : []);
      if ([...meus].some((produto) => !ids.includes(produto))) {
        throw new BadRequestException('Produto não é desta solicitação');
      }
      if (dto.aprova && meus.size === 0) {
        throw new BadRequestException(
          'Marque ao menos um produto; para não aceitar nenhum, recuse',
        );
      }

      // a outra decisão, se já houve, é aprovação: a recusa teria encerrado.
      // Sem a tesouraria no trâmite não há outro lado: o pastor fecha sozinho
      const outroAprovou =
        exigeTesouraria &&
        (pastor ? atual.treasuryDecision : atual.pastorDecision) === true;
      const fecha = !exigeTesouraria || outroAprovou;
      const doOutro = (item: (typeof atual.items)[number]) =>
        pastor ? item.treasuryAccepted : item.pastorAccepted;
      /** O resultado do produto: só no fim, e só o que os dois aprovaram */
      const final = (item: (typeof atual.items)[number]) =>
        !dto.aprova
          ? false
          : !fecha
          ? null
          : meus.has(item.id) && (!exigeTesouraria || doOutro(item) === true);

      const emComum = atual.items.filter((item) => final(item)).length;
      const status = !dto.aprova
        ? ChurchRequestStatus.REJECTED
        : !fecha
        ? pastor
          ? ChurchRequestStatus.AWAITING_TREASURY
          : ChurchRequestStatus.AWAITING_PASTOR
        : emComum === 0
        ? ChurchRequestStatus.REJECTED
        : emComum === ids.length
        ? ChurchRequestStatus.ACCEPTED
        : ChurchRequestStatus.PARTIALLY_ACCEPTED;

      for (const item of atual.items) {
        const aprovado = meus.has(item.id);
        await tx.churchRequestItem.update({
          where: { id: item.id },
          data: {
            ...(pastor
              ? { pastorAccepted: aprovado }
              : { treasuryAccepted: aprovado }),
            accepted: final(item),
          },
        });
      }

      const agora = new Date();
      return tx.churchRequest.update({
        where: { id },
        data: {
          status,
          ...(pastor
            ? { pastorDecision: dto.aprova, pastorId: userId, pastorAt: agora }
            : {
                treasuryDecision: dto.aprova,
                treasurerId: userId,
                treasuryAt: agora,
              }),
          ...(dto.resposta !== undefined && {
            response: dto.resposta.trim() || null,
          }),
        },
        select: CAMPOS_DA_IGREJA,
      });
    });

    // o membro fica sabendo do fim; o "aguardando" é trâmite de dentro, e
    // avisa só quem falta decidir
    if (DECIDIDA.includes(salva.status)) {
      await notificarRespostaDaSolicitacao(this.prisma, id, userId);
    } else {
      await notificarVezNaSolicitacao(this.prisma, id, userId);
    }
    return salva;
  }
}

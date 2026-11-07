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
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from 'src/auth/roles';
import { exigirModulo } from 'src/planos/modulos';
import {
  notificarRespostaDaSolicitacao,
  notificarSolicitacao,
} from 'src/notificacoes/notificar';
import {
  CriarSolicitacaoDto,
  DecidirDto,
  MudarStatusDto,
} from './solicitacoes.dto';

const CAMPOS = {
  id: true,
  ministry: true,
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

/** O fim do trâmite: ninguém decide mais */
const DECIDIDA: ChurchRequestStatus[] = [
  ChurchRequestStatus.ACCEPTED,
  ChurchRequestStatus.PARTIALLY_ACCEPTED,
  ChurchRequestStatus.REJECTED,
];

/** Quem decide: o pastor (líder espiritual da igreja) ou a tesouraria dela */
export type LadoDaDecisao = 'PASTOR' | 'TESOURARIA';

/**
 * Módulo Solicitações: o membro pede à igreja de que é membro (um ou mais
 * produtos). Aprovar pede duas confirmações, em qualquer ordem — a do pastor e
 * a de uma tesouraria da igreja —, e recusar basta uma (`decidir`). O admin
 * que não é nenhum dos dois acompanha, põe em análise e responde ao membro
 * (`mudarStatus`).
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

  /** As solicitações da igreja, com quem pediu e as decisões, as novas primeiro */
  daIgreja(churchId: string) {
    return this.prisma.churchRequest.findMany({
      where: { churchId },
      orderBy: { createdAt: 'desc' },
      select: CAMPOS_DA_IGREJA,
    });
  }

  /**
   * Como quem está logado decide nesta igreja: pastor (o líder espiritual,
   * `Church.spiritualLeaderId`), tesouraria (o vínculo dela aqui) ou nenhum.
   * `temPastor` avisa a tela da igreja sem pastor cadastrado, que não consegue
   * aprovar nada até cadastrarem um.
   */
  async papel(churchId: string, userId: string) {
    const [igreja, tesouraria] = await Promise.all([
      this.prisma.church.findUnique({
        where: { id: churchId },
        select: { spiritualLeaderId: true },
      }),
      this.prisma.userChurchRole.findFirst({
        where: { churchId, userId, role: Role.TESOURARIA },
        select: { userId: true },
      }),
    ]);
    const lado: LadoDaDecisao | null =
      igreja?.spiritualLeaderId === userId
        ? 'PASTOR'
        : tesouraria
        ? 'TESOURARIA'
        : null;
    return { lado, temPastor: !!igreja?.spiritualLeaderId };
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

    const mudaSituacao = !!dto.status && dto.status !== atual.status;
    if (mudaSituacao && !ANTES_DA_DECISAO.includes(atual.status)) {
      throw new ConflictException(
        'A solicitação já está com o pastor e a tesouraria: a situação muda pela decisão deles',
      );
    }

    const salva = await this.prisma.churchRequest.update({
      where: { id },
      data: {
        ...(mudaSituacao && { status: dto.status }),
        ...(dto.resposta !== undefined && {
          response: dto.resposta.trim() || null,
        }),
      },
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
    const { lado } = await this.papel(churchId, userId);
    if (!lado) {
      throw new ForbiddenException(
        'Só o pastor e a tesouraria da igreja aprovam ou recusam',
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
        throw new ConflictException('Esta solicitação já foi decidida');
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

      // a outra decisão, se já houve, é aprovação: a recusa teria encerrado
      const outroAprovou =
        (pastor ? atual.treasuryDecision : atual.pastorDecision) === true;
      const doOutro = (item: (typeof atual.items)[number]) =>
        pastor ? item.treasuryAccepted : item.pastorAccepted;
      /** O resultado do produto: só no fim, e só o que os dois aprovaram */
      const final = (item: (typeof atual.items)[number]) =>
        !dto.aprova
          ? false
          : outroAprovou
          ? meus.has(item.id) && doOutro(item) === true
          : null;

      const emComum = atual.items.filter((item) => final(item)).length;
      const status = !dto.aprova
        ? ChurchRequestStatus.REJECTED
        : !outroAprovou
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

    // o membro fica sabendo do fim; o "aguardando" é trâmite de dentro
    if (DECIDIDA.includes(salva.status)) {
      await notificarRespostaDaSolicitacao(this.prisma, id, userId);
    }
    return salva;
  }
}

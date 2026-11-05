import {
  BadRequestException,
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
import { exigirModulo } from 'src/planos/modulos';
import { CriarSolicitacaoDto, MudarStatusDto } from './solicitacoes.dto';

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
 * Módulo Solicitações: o membro pede à igreja de que é membro (um ou mais
 * produtos), e o admin dela responde mudando a situação (solicitado, em
 * análise, recusado, aceito ou aceito parcialmente).
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

    return this.prisma.churchRequest.create({
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
  }

  /** As solicitações da igreja, com quem pediu, as novas primeiro */
  daIgreja(churchId: string) {
    return this.prisma.churchRequest.findMany({
      where: { churchId },
      orderBy: { createdAt: 'desc' },
      select: {
        ...CAMPOS,
        requester: {
          select: {
            id: true,
            fullName: true,
            profilePhotoUrl: true,
            cellphone: true,
          },
        },
      },
    });
  }

  /**
   * A solicitação tem que ser desta igreja: o guard confere que a pessoa
   * administra a igreja da URL, e aqui se confere que o pedido é dela — senão
   * trocar o id bastava para responder o pedido de outra igreja.
   *
   * A situação decide cada produto: aceita, todos aceitos; recusada, nenhum;
   * sem resposta ainda, nenhum decidido. Aceita parcialmente, aceitos são os
   * de `produtosAceitos`, que precisam ser deste pedido, e alguns — nem
   * nenhum (seria recusada) nem todos (seria aceita).
   */
  async mudarStatus(churchId: string, id: string, dto: MudarStatusDto) {
    const atual = await this.prisma.churchRequest.findFirst({
      where: { id, churchId },
      select: { id: true, items: { select: { id: true } } },
    });
    if (!atual) throw new NotFoundException('Solicitação não encontrada');

    const ids = atual.items.map((item) => item.id);
    const aceitos = new Set(
      dto.status === ChurchRequestStatus.PARTIALLY_ACCEPTED
        ? dto.produtosAceitos ?? []
        : [],
    );
    if (dto.status === ChurchRequestStatus.PARTIALLY_ACCEPTED) {
      if ([...aceitos].some((aceito) => !ids.includes(aceito))) {
        throw new BadRequestException('Produto não é desta solicitação');
      }
      if (aceitos.size === 0 || aceitos.size === ids.length) {
        throw new BadRequestException(
          'Para aceitar em parte, marque alguns produtos: nem nenhum, nem todos',
        );
      }
    }

    const decisao = (itemId: string): boolean | null => {
      switch (dto.status) {
        case ChurchRequestStatus.ACCEPTED:
          return true;
        case ChurchRequestStatus.REJECTED:
          return false;
        case ChurchRequestStatus.PARTIALLY_ACCEPTED:
          return aceitos.has(itemId);
        default:
          return null;
      }
    };

    // interativa: com a forma em array, o middleware de auditoria descarta as
    // escritas sem lançar erro
    return this.prisma.$transaction(async (tx) => {
      for (const itemId of ids) {
        await tx.churchRequestItem.update({
          where: { id: itemId },
          data: { accepted: decisao(itemId) },
        });
      }
      return tx.churchRequest.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.resposta !== undefined && {
            response: dto.resposta.trim() || null,
          }),
        },
        select: CAMPOS,
      });
    });
  }
}

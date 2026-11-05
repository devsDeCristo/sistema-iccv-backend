import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChurchModule, ChurchStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { exigirModulo } from 'src/planos/modulos';
import { CriarSolicitacaoDto, MudarStatusDto } from './solicitacoes.dto';

const CAMPOS = {
  id: true,
  ministry: true,
  title: true,
  description: true,
  link: true,
  status: true,
  response: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Módulo Solicitações: o membro pede à igreja de que é membro, e o admin dela
 * responde mudando a situação (solicitado, em análise, recusado, aceito).
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
        link: dto.link?.trim() || null,
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
   */
  async mudarStatus(churchId: string, id: string, dto: MudarStatusDto) {
    const atual = await this.prisma.churchRequest.findFirst({
      where: { id, churchId },
      select: { id: true },
    });
    if (!atual) throw new NotFoundException('Solicitação não encontrada');

    return this.prisma.churchRequest.update({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.resposta !== undefined && {
          response: dto.resposta.trim() || null,
        }),
      },
      select: CAMPOS,
    });
  }
}

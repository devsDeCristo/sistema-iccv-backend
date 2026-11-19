import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChurchModule, ChurchStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { exigirModulo } from 'src/planos/modulos';
import {
  AtualizarOportunidadeDto,
  CriarOportunidadeDto,
} from './oportunidades.dto';

const CAMPOS = {
  id: true,
  title: true,
  company: true,
  description: true,
  location: true,
  isOpen: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** No painel: quem publicou e quem se interessou, com o contato para exportar */
const CAMPOS_DA_IGREJA = {
  ...CAMPOS,
  createdBy: { select: { id: true, fullName: true } },
  interests: {
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          cellphone: true,
          profilePhotoUrl: true,
        },
      },
    },
  },
} as const;

/**
 * Módulo Oportunidades: o admin da igreja publica vagas de emprego (na igreja
 * ou na empresa de um membro), os membros dela demonstram interesse, e o admin
 * exporta a lista para quem ofereceu a vaga.
 */
@Injectable()
export class OportunidadesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A igreja de que a pessoa é membro agora — ativa e com o módulo no plano.
   * É sempre ela, nunca uma vinda da requisição: ninguém vê as vagas da
   * igreja dos outros.
   */
  private async igrejaDoMembro(userId: string) {
    const pessoa = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { memberChurch: { select: { id: true, status: true } } },
    });
    const igreja = pessoa?.memberChurch;
    if (!igreja || igreja.status === ChurchStatus.INACTIVE) {
      throw new ForbiddenException(
        'As oportunidades são só para os membros da igreja',
      );
    }
    await exigirModulo(this.prisma, igreja.id, ChurchModule.OPPORTUNITIES);
    return igreja.id;
  }

  /** As vagas abertas da igreja do membro, com o interesse dele em cada uma */
  async abertas(userId: string) {
    const churchId = await this.igrejaDoMembro(userId);
    const vagas = await this.prisma.opportunity.findMany({
      where: { churchId, isOpen: true },
      orderBy: { createdAt: 'desc' },
      select: {
        ...CAMPOS,
        interests: { where: { userId }, select: { createdAt: true } },
      },
    });
    return vagas.map(({ interests, ...vaga }) => ({
      ...vaga,
      interessei: interests.length > 0,
    }));
  }

  /**
   * A vaga tem que ser da igreja do membro (de outra igreja é 404, sem dizer
   * que existe) e estar aberta. Repetir não duplica: é um por pessoa e vaga.
   */
  async interessar(userId: string, id: string) {
    const churchId = await this.igrejaDoMembro(userId);
    const vaga = await this.prisma.opportunity.findFirst({
      where: { id, churchId },
      select: { isOpen: true },
    });
    if (!vaga) throw new NotFoundException('Oportunidade não encontrada');
    if (!vaga.isOpen) {
      throw new ConflictException('Esta oportunidade foi encerrada');
    }
    await this.prisma.opportunityInterest.upsert({
      where: { opportunityId_userId: { opportunityId: id, userId } },
      create: { opportunityId: id, userId },
      update: {},
    });
    return { interessei: true };
  }

  /**
   * Retirar o interesse só apaga a linha da própria pessoa: não precisa ser
   * membro ainda nem a vaga estar aberta — o dado é dela.
   */
  async desinteressar(userId: string, id: string) {
    await this.prisma.opportunityInterest.deleteMany({
      where: { opportunityId: id, userId },
    });
    return { interessei: false };
  }

  // ponytail: interessados vêm junto da lista; separar em rota própria se as vagas passarem de centenas
  /** As vagas da igreja, abertas e encerradas, com os interessados */
  daIgreja(churchId: string) {
    return this.prisma.opportunity.findMany({
      where: { churchId },
      orderBy: { createdAt: 'desc' },
      select: CAMPOS_DA_IGREJA,
    });
  }

  criar(churchId: string, userId: string, dto: CriarOportunidadeDto) {
    return this.prisma.opportunity.create({
      data: {
        churchId,
        createdById: userId,
        title: dto.titulo.trim(),
        company: dto.empresa.trim(),
        description: dto.descricao.trim(),
        location: dto.local?.trim() || null,
        isOpen: dto.aberta ?? true,
      },
      select: CAMPOS_DA_IGREJA,
    });
  }

  /**
   * O guard confere que a pessoa é admin da igreja da URL; aqui, que a vaga é
   * dessa igreja — senão trocar o id bastava para mexer na vaga de outra.
   */
  private async daIgrejaOu404(churchId: string, id: string) {
    const vaga = await this.prisma.opportunity.findFirst({
      where: { id, churchId },
      select: { id: true },
    });
    if (!vaga) throw new NotFoundException('Oportunidade não encontrada');
  }

  /** Campo ausente não muda; `local` vazio apaga */
  async atualizar(churchId: string, id: string, dto: AtualizarOportunidadeDto) {
    await this.daIgrejaOu404(churchId, id);
    return this.prisma.opportunity.update({
      where: { id },
      data: {
        ...(dto.titulo !== undefined && { title: dto.titulo.trim() }),
        ...(dto.empresa !== undefined && { company: dto.empresa.trim() }),
        ...(dto.descricao !== undefined && {
          description: dto.descricao.trim(),
        }),
        ...(dto.local !== undefined && {
          location: dto.local.trim() || null,
        }),
        ...(dto.aberta !== undefined && { isOpen: dto.aberta }),
      },
      select: CAMPOS_DA_IGREJA,
    });
  }

  /** Apaga a vaga e a lista de interessados junto */
  async excluir(churchId: string, id: string) {
    await this.daIgrejaOu404(churchId, id);
    await this.prisma.opportunity.delete({ where: { id } });
  }
}

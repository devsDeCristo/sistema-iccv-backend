import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PlanoDto } from './dto/plano.dto';

const SELECT_PLANO = {
  id: true,
  name: true,
  description: true,
  modules: true,
  _count: { select: { churches: true } },
} as const;

/** Os planos: quais módulos cada igreja usa. Ver `Plan` */
@Injectable()
export class PlanosService {
  constructor(private readonly prisma: PrismaService) {}

  listar() {
    return this.prisma.plan.findMany({
      select: SELECT_PLANO,
      orderBy: { name: 'asc' },
    });
  }

  async criar(dto: PlanoDto) {
    const name = dto.name.trim();
    await this.nomeLivre(name);
    return this.prisma.plan.create({
      data: {
        name,
        description: dto.description?.trim() || null,
        modules: dto.modules,
      },
      select: SELECT_PLANO,
    });
  }

  /** Mudar os módulos vale na hora para todas as igrejas do plano */
  async atualizar(id: string, dto: PlanoDto) {
    await this.existe(id);
    const name = dto.name.trim();
    await this.nomeLivre(name, id);
    return this.prisma.plan.update({
      where: { id },
      data: {
        name,
        description: dto.description?.trim() || null,
        modules: dto.modules,
      },
      select: SELECT_PLANO,
    });
  }

  /** Plano em uso não se apaga: as igrejas dele ficariam sem módulo nenhum */
  async remover(id: string) {
    const plano = await this.existe(id);
    if (plano._count.churches) {
      throw new ConflictException(
        `Este plano está em ${plano._count.churches} ${
          plano._count.churches === 1 ? 'igreja' : 'igrejas'
        }. Troque o plano delas antes de apagá-lo.`,
      );
    }
    await this.prisma.plan.delete({ where: { id } });
  }

  private async existe(id: string) {
    const plano = await this.prisma.plan.findUnique({
      where: { id },
      select: SELECT_PLANO,
    });
    if (!plano) throw new NotFoundException('Plano não encontrado');
    return plano;
  }

  private async nomeLivre(name: string, ignorar?: string) {
    const outro = await this.prisma.plan.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(ignorar ? { id: { not: ignorar } } : {}),
      },
      select: { id: true },
    });
    if (outro) throw new ConflictException('Já existe um plano com este nome');
  }
}

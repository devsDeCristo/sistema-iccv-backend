import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateChurchDto } from './dto/create-church.dto';

@Injectable()
export class ChurchService {
  constructor(private prisma: PrismaService) {}

  /**
   * Os contadores alimentam a tela de gestão e explicam por que uma igreja não
   * pode ser removida. `users` conta só quem entra no painel — inscrito não
   * pertence a igreja nenhuma.
   */
  async findAll() {
    return this.prisma.church.findMany({
      select: {
        id: true,
        name: true,
        _count: { select: { users: true, events: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateChurchDto) {
    const name = dto.name.trim();
    await this.ensureNameIsAvailable(name);

    return this.prisma.church.create({
      data: { name },
      select: { id: true, name: true },
    });
  }

  async update(id: string, dto: CreateChurchDto) {
    const name = dto.name.trim();
    await this.findOneOrFail(id);
    await this.ensureNameIsAvailable(name, id);

    return this.prisma.church.update({
      where: { id },
      data: { name },
      select: { id: true, name: true },
    });
  }

  /**
   * Remove só a igreja vazia. O `onDelete: Cascade` de `Event.churchId` apagaria
   * os eventos junto — inscrições, pagamentos e check-ins todos com eles.
   */
  async remove(id: string) {
    const church = await this.findOneOrFail(id);

    if (church._count.events > 0 || church._count.users > 0) {
      // `users` aqui é só o pessoal do painel: inscrito não tem igreja
      const vinculos = [
        church._count.events && `${church._count.events} evento(s)`,
        church._count.users && `${church._count.users} administrador(es)`,
      ].filter(Boolean);

      throw new BadRequestException(
        `"${church.name}" ainda tem ${vinculos.join(
          ' e ',
        )}. Remova ou transfira antes de apagar a igreja.`,
      );
    }

    await this.prisma.church.delete({ where: { id } });
  }

  private async findOneOrFail(id: string) {
    const church = await this.prisma.church.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        _count: { select: { users: true, events: true } },
      },
    });

    if (!church) {
      throw new NotFoundException('Igreja não encontrada');
    }

    return church;
  }

  private async ensureNameIsAvailable(name: string, ignoreId?: string) {
    const existente = await this.prisma.church.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        id: ignoreId ? { not: ignoreId } : undefined,
      },
      select: { id: true },
    });

    if (existente) {
      throw new ConflictException('Já existe uma igreja com esse nome');
    }
  }
}

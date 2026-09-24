import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role, SUPER_ADMIN_ROLES } from 'src/auth/roles';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateChurchDto } from './dto/create-church.dto';

/** O que as telas de igreja leem: nome, situação e quem assina os e-mails. */
const SELECT_CHURCH = {
  id: true,
  name: true,
  status: true,
  spiritualLeader: { select: { id: true, fullName: true } },
};

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
        ...SELECT_CHURCH,
        _count: { select: { users: true, events: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateChurchDto) {
    const name = dto.name.trim();
    await this.ensureNameIsAvailable(name);
    const lider = await this.findLeaderOrFail(dto.spiritualLeaderId);

    return this.prisma.$transaction(async (tx) => {
      const church = await tx.church.create({
        data: {
          name,
          status: dto.status,
          spiritualLeaderId: dto.spiritualLeaderId ?? null,
        },
        select: SELECT_CHURCH,
      });

      if (lider) await this.vincularLider(tx, church.id, lider);

      return church;
    });
  }

  async update(id: string, dto: CreateChurchDto) {
    const name = dto.name.trim();
    await this.findOneOrFail(id);
    await this.ensureNameIsAvailable(name, id);
    const lider = await this.findLeaderOrFail(dto.spiritualLeaderId);

    return this.prisma.$transaction(async (tx) => {
      const church = await tx.church.update({
        where: { id },
        // `status` ausente no corpo mantém o que está gravado: quem só renomeia
        // não deve reativar uma igreja que alguém desligou. Vale igual para o
        // líder — só troca quem veio no corpo.
        data: {
          name,
          status: dto.status,
          spiritualLeaderId: dto.spiritualLeaderId,
        },
        select: SELECT_CHURCH,
      });

      if (lider) await this.vincularLider(tx, id, lider);

      return church;
    });
  }

  /**
   * Quem responde pela igreja administra a igreja: o vínculo de admin sai
   * junto com o cadastro, na mesma transação. Sem isso o líder ficaria
   * registrado na igreja sem conseguir abrir o painel dela.
   *
   * Trocar de líder não rebaixa o anterior: ele continua admin até alguém
   * tirar a permissão pela tela de usuários — perder o acesso ao painel não é
   * consequência óbvia de deixar de assinar o e-mail.
   */
  private async vincularLider(
    tx: Prisma.TransactionClient,
    churchId: string,
    lider: { id: string; role: number },
  ) {
    await tx.userChurchRole.upsert({
      where: { userId_churchId: { userId: lider.id, churchId } },
      create: { userId: lider.id, churchId, role: Role.ADMIN },
      update: { role: Role.ADMIN },
    });

    // `User.role` é derivado do mais alto dos vínculos, e admin é o mais alto
    // que um vínculo dá. Dev e super admin são perfis globais: escrever admin
    // por cima deles seria rebaixá-los.
    if (!SUPER_ADMIN_ROLES.includes(lider.role as Role)) {
      await tx.user.update({
        where: { id: lider.id },
        data: { role: Role.ADMIN },
      });
    }
  }

  /**
   * A conta do líder é conferida antes de gravar: o erro do banco pela chave
   * estrangeira sairia como 500, e isto aqui é um id errado no corpo.
   */
  private async findLeaderOrFail(userId?: string | null) {
    if (!userId) return null;

    const pessoa = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!pessoa) {
      throw new BadRequestException('Usuário não encontrado');
    }

    return pessoa;
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

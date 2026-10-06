import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from 'src/auth/roles';
import { perfilEfetivo, SELECT_TENANT } from 'src/auth/tenant';
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
      await this.recalcularPerfis(tx, church.id);

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
      await this.recalcularPerfis(tx, id);

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
   *
   * O `User.role` do líder sai de `recalcularPerfis`, logo depois: em igreja
   * inativa o vínculo fica gravado, mas não dá o painel.
   */
  private async vincularLider(
    tx: Prisma.TransactionClient,
    churchId: string,
    lider: { id: string },
  ) {
    await tx.userChurchRole.upsert({
      where: { userId_churchId: { userId: lider.id, churchId } },
      create: { userId: lider.id, churchId, role: Role.ADMIN },
      update: { role: Role.ADMIN },
    });
  }

  /**
   * `User.role` é derivado dos vínculos que valem — os de igreja não inativa
   * (`SELECT_TENANT`). Desativar a igreja derruba para usuário comum quem só
   * administrava ela; reativar devolve o perfil. Quem tem vínculo em outra
   * igreja ativa continua com o perfil de lá, e dev e super admin não mudam.
   *
   * Roda em todo salvamento da igreja, na mesma transação: é o `RolesGuard` e
   * o `/auth/admin/validate` que leem `User.role`, e ele não pode ficar
   * dizendo admin de uma igreja que já saiu do ar.
   */
  private async recalcularPerfis(
    tx: Prisma.TransactionClient,
    churchId: string,
  ) {
    const pessoas = await tx.user.findMany({
      where: { churchRoles: { some: { churchId } } },
      select: { id: true, ...SELECT_TENANT },
    });

    for (const pessoa of pessoas) {
      const efetivo = perfilEfetivo(pessoa);
      if (pessoa.role !== efetivo) {
        await tx.user.update({
          where: { id: pessoa.id },
          data: { role: efetivo },
        });
      }
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
      select: { id: true },
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

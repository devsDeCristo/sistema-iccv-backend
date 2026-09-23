import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { moduloAtivo } from '../event/event-modules';
import { TransportDto } from './dto/transport.dto';

/**
 * Transporte do evento — o ônibus, a van, o carro que leva o grupo.
 *
 * É o gêmeo de `BedroomsService`: capacidade, tags e restrição por grupo de
 * inscrição funcionam igual, porque o problema é o mesmo — encaixar pessoas em
 * lugares que têm limite. Quando as características do veículo entrarem (placa,
 * motorista, horário de saída), é aqui que elas moram.
 */
@Injectable()
export class TransportService {
  constructor(private prisma: PrismaService) {}

  /**
   * Grupos de inscrição de cada usuário no evento. A pessoa pode estar em mais
   * de um grupo, então o valor é um conjunto.
   */
  async groupsByUser(eventId: string, userIds: string[]) {
    if (!userIds.length) return new Map<string, Set<string>>();

    const inscricoes = await this.prisma.eventOnUsersRolesRegistration.findMany(
      {
        where: { eventId, userId: { in: userIds } },
        select: {
          userId: true,
          role: { select: { group: { select: { name: true } } } },
        },
      },
    );

    const porUsuario = new Map<string, Set<string>>();
    for (const inscricao of inscricoes) {
      const nome = inscricao.role?.group?.name;
      if (!nome) continue;
      const grupos = porUsuario.get(inscricao.userId) || new Set<string>();
      grupos.add(nome);
      porUsuario.set(inscricao.userId, grupos);
    }

    return porUsuario;
  }

  /**
   * Quem ocupa um lugar tem que estar inscrito no evento. Os ids vêm do corpo
   * da requisição: sem esta conferência, um id de pessoa de outra igreja (ou de
   * quem nem se inscreveu) viraria passageiro e apareceria na lista do evento.
   */
  private async assertUsersNoEvento(eventId: string, userIds: string[]) {
    const ids = Array.from(new Set(userIds ?? [])).filter(Boolean);
    if (!ids.length) return;

    const inscritos = await this.prisma.eventOnUsers.count({
      where: { eventId, userId: { in: ids } },
    });

    if (inscritos !== ids.length) {
      throw new BadRequestException(
        'Há pessoas na lista que não estão inscritas neste evento',
      );
    }
  }

  /**
   * Transporte com `groupTags` é restrito: só entra quem pertence a um dos
   * grupos. Sem tag nenhuma ele é aberto e não há o que validar.
   */
  private async assertUsersAllowed(
    eventId: string,
    groupTags: string[] | undefined,
    userIds: string[],
  ) {
    const tags = (groupTags || []).filter(Boolean);
    if (!tags.length || !userIds.length) return;

    const porUsuario = await this.groupsByUser(eventId, userIds);
    const foraDoGrupo = userIds.filter((userId) => {
      const grupos = porUsuario.get(userId);
      if (!grupos) return true;
      return !tags.some((tag) => grupos.has(tag));
    });

    if (!foraDoGrupo.length) return;

    const usuarios = await this.prisma.user.findMany({
      where: { id: { in: foraDoGrupo } },
      select: { fullName: true },
    });
    const nomes = usuarios.map((usuario) => usuario.fullName).join(', ');

    throw new BadRequestException(
      `Transporte restrito a ${tags.join(
        ', ',
      )}. Fora desse(s) grupo(s): ${nomes}`,
    );
  }

  async createRelations(usersIds: string[], idTransport: string) {
    const existRelation = await this.prisma.transportOnUsers.findMany({
      where: { userId: { in: usersIds }, transportId: idTransport },
    });

    const jaVinculados = existRelation.map((relacao) => relacao.userId);
    const novos = (usersIds ?? []).filter((id) => !jaVinculados.includes(id));

    if (novos.length > 0) {
      await this.prisma.transportOnUsers.createMany({
        data: novos.map((userId: string) => ({
          userId,
          transportId: idTransport,
        })),
      });
    }
  }

  /**
   * Módulo desligado não recebe cadastro. A tela já esconde a aba, mas a rota
   * existe: sem esta trava, um formulário aberto antes de desligar o módulo
   * ainda gravaria.
   */
  private async assertModuloLigado(eventId: string) {
    const evento = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { data: true },
    });

    if (!moduloAtivo(evento?.data, 'transport')) {
      throw new BadRequestException(
        'O módulo Transporte está desligado neste evento',
      );
    }
  }

  async create(idEvent: string, createTransport: TransportDto) {
    // fora do try: o catch abaixo é genérico e transformaria a recusa de grupo
    // num 500 sem explicação
    await this.assertModuloLigado(idEvent);
    await this.assertUsersNoEvento(idEvent, createTransport.usersId || []);
    await this.assertUsersAllowed(
      idEvent,
      createTransport.groupTags,
      createTransport.usersId || [],
    );

    try {
      const transport = await this.prisma.transport.create({
        data: {
          eventId: idEvent,
          note: createTransport.note,
          name: createTransport.name,
          capacity: createTransport.capacity,
          tag: createTransport.tags,
          groupTags: createTransport.groupTags || [],
        },
      });

      // aguardado de propósito: solto num .then(), o transporte era criado e a
      // falha ao vincular os passageiros passava calada
      await this.createRelations(createTransport.usersId, transport.id);
    } catch {
      throw new InternalServerErrorException();
    }
  }

  async findAll(eventId: string) {
    return await this.prisma.transport
      .findMany({
        where: { eventId },
        include: {
          event: { select: { id: true, name: true } },
          users: {
            select: {
              user: {
                select: { id: true, fullName: true, profilePhotoUrl: true },
              },
            },
          },
        },
      })
      .then((transportes) =>
        transportes.map((transporte) => ({
          ...transporte,
          users: transporte.users.map((relacao) => relacao.user),
        })),
      );
  }

  /**
   * O transporte é procurado dentro do evento da URL. O `EventTenantGuard`
   * garante que o evento é da igreja de quem pediu; sem amarrar os dois, um id
   * de transporte de outra igreja passaria por aqui.
   */
  async findOne(id: string, eventId: string) {
    return await this.prisma.transport
      .findFirst({
        where: { id, eventId },
        include: {
          event: { select: { id: true, name: true } },
          users: { select: { user: { select: { id: true, fullName: true } } } },
        },
      })
      .then((transporte) => ({
        ...transporte,
        users: transporte?.users?.map((relacao) => relacao.user),
      }));
  }

  async update(
    idEvent: string,
    idTransport: string,
    updateTransportDto: TransportDto,
  ) {
    const existe = await this.prisma.transport.findFirst({
      where: { id: idTransport, eventId: idEvent },
    });

    if (!existe) {
      throw new NotFoundException('Transporte não encontrado');
    }

    await this.assertUsersNoEvento(idEvent, updateTransportDto.usersId || []);
    await this.assertUsersAllowed(
      idEvent,
      updateTransportDto.groupTags,
      updateTransportDto.usersId || [],
    );

    // quem saiu da lista perde o lugar
    await this.prisma.transportOnUsers.deleteMany({
      where: {
        transportId: idTransport,
        NOT: { userId: { in: updateTransportDto.usersId } },
      },
    });

    await this.prisma.transport.update({
      data: {
        eventId: idEvent,
        note: updateTransportDto.note,
        name: updateTransportDto.name,
        capacity: updateTransportDto.capacity,
        tag: updateTransportDto.tags,
        groupTags: updateTransportDto.groupTags || [],
      },
      where: { id: idTransport },
    });

    await this.createRelations(updateTransportDto.usersId, idTransport);
  }

  async delete(idTransport: string, idEvent: string) {
    const existe = await this.prisma.transport.findFirst({
      where: { id: idTransport, eventId: idEvent },
    });

    if (!existe) {
      throw new NotFoundException('Transporte não encontrado');
    }

    await this.prisma.transportOnUsers.deleteMany({
      where: { transportId: idTransport },
    });

    await this.prisma.transport.delete({ where: { id: idTransport } });
  }
}

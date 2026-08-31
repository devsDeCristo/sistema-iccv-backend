import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { BedroomDto } from './dto/bedroom.dto';

@Injectable()
export class BedroomsService {
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
   * Quarto com `groupTags` é restrito: só entra quem pertence a um dos grupos.
   * Sem tag nenhuma o quarto é aberto e não há o que validar.
   *
   * A checagem vale para a montagem manual do quarto, não só para a alocação
   * automática do check-in — do contrário a tag valeria apenas metade do tempo.
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
      `Quarto restrito a ${tags.join(', ')}. Fora desse(s) grupo(s): ${nomes}`,
    );
  }

  async createRelations(usersIds: string[], idBedroom: string) {
    const existRelation = await this.prisma.bedroomsOnUsers.findMany({
      where: { userId: { in: usersIds }, bedroomsId: idBedroom },
    });

    const getUsersId = existRelation.map((e) => e.userId);

    const filterIds = usersIds.filter((id) => !getUsersId.includes(id));

    if (filterIds.length > 0) {
      await this.prisma.bedroomsOnUsers.createMany({
        data: filterIds.map((id: string) => {
          return { userId: id, bedroomsId: idBedroom };
        }),
      });
    }
  }

  async create(idEvent: string, createBedroom: BedroomDto) {
    // fora do try: o catch abaixo é genérico e transformaria a recusa de grupo
    // num 500 sem explicação
    await this.assertUsersAllowed(
      idEvent,
      createBedroom.groupTags,
      createBedroom.usersId || [],
    );

    try {
      const bedroom = await this.prisma.bedrooms.create({
        data: {
          eventId: idEvent,
          note: createBedroom.note,
          name: createBedroom.name,
          capacity: createBedroom.capacity,
          tag: createBedroom.tags,
          groupTags: createBedroom.groupTags || [],
        },
      });

      // aguardado de propósito: solto num .then(), o quarto era criado e a
      // falha ao vincular os ocupantes passava calada
      await this.createRelations(createBedroom.usersId, bedroom.id);
    } catch {
      throw new InternalServerErrorException();
    }
  }

  async findAll(eventId: string) {
    return await this.prisma.bedrooms
      .findMany({
        where: {
          eventId,
        },
        include: {
          event: {
            select: {
              id: true,
              name: true,
            },
          },
          users: {
            select: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  profilePhotoUrl: true,
                },
              },
            },
          },
        },
      })
      .then((bedrooms) =>
        bedrooms.map((bedroom) => ({
          ...bedroom,
          users: bedroom.users.map((e) => e.user),
        })),
      );
  }

  /**
   * O quarto é procurado dentro do evento da URL. O `EventTenantGuard` garante
   * que o evento é da igreja de quem pediu; sem amarrar os dois, um id de
   * quarto de outra igreja passaria por aqui.
   */
  async findOne(id: string, eventId: string) {
    return await this.prisma.bedrooms
      .findFirst({
        where: { id, eventId },
        include: {
          event: {
            select: {
              id: true,
              name: true,
            },
          },
          users: {
            select: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                },
              },
            },
          },
        },
      })
      .then((bedrooms) => ({
        ...bedrooms,
        users: bedrooms?.users?.map((e) => e.user),
      }));
  }

  async update(
    idEvent: string,
    idBedroom: string,
    updateBedroomDto: BedroomDto,
  ) {
    const bedroomExist = await this.prisma.bedrooms.findFirst({
      where: {
        id: idBedroom,
        eventId: idEvent,
      },
    });

    if (!bedroomExist) {
      throw new NotFoundException('Bedroom does not exists!');
    }

    await this.assertUsersAllowed(
      idEvent,
      updateBedroomDto.groupTags,
      updateBedroomDto.usersId || [],
    );

    // Remove relations for users that are not in the updated list
    await this.prisma.bedroomsOnUsers.deleteMany({
      where: {
        bedroomsId: idBedroom,
        NOT: {
          userId: {
            in: updateBedroomDto.usersId,
          },
        },
      },
    });

    // Update the bedroom
    await this.prisma.bedrooms.update({
      data: {
        eventId: idEvent,
        note: updateBedroomDto.note,
        name: updateBedroomDto.name,
        capacity: updateBedroomDto.capacity,
        tag: updateBedroomDto.tags,
        groupTags: updateBedroomDto.groupTags || [],
      },
      where: {
        id: idBedroom,
      },
    });

    // Create relations for new users
    await this.createRelations(updateBedroomDto.usersId, idBedroom);
  }

  async delete(idBedroom: string, idEvent: string) {
    const bedroomExist = await this.prisma.bedrooms.findFirst({
      where: {
        id: idBedroom,
        eventId: idEvent,
      },
    });

    if (!bedroomExist) {
      throw new NotFoundException('Bedroom does not exist!');
    }

    // Delete relations
    await this.prisma.bedroomsOnUsers.deleteMany({
      where: {
        bedroomsId: idBedroom,
      },
    });

    // Deleta bedroom
    await this.prisma.bedrooms.delete({
      where: {
        id: idBedroom,
      },
    });
  }
}

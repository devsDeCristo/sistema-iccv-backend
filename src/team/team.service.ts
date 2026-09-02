import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, TeamRole } from '../prisma';
import { TeammDto } from './dto/team.dto';

@Injectable()
export class TeamService {
  constructor(private prisma: PrismaService) {}

  async createRelations(
    usersLeadersIds: string[],
    usersIds: string[],
    idTeam: string,
  ) {
    const membersToAdd = usersIds.map((id) => ({
      userId: id,
      teamId: idTeam,
      role: TeamRole.MEMBER,
    }));

    const leadersToAdd = usersLeadersIds.map((id) => ({
      userId: id,
      teamId: idTeam,
      role: TeamRole.LEADER,
    }));

    // prioridade para role de lider caso o usuario esteja nas duas listas
    const uniqueUsers = Array.from(
      new Map(
        [...membersToAdd, ...leadersToAdd].map((item) => [item.userId, item]),
      ).values(),
    );

    // upsert para criar ou atualizar role
    await this.prisma
      .$transaction(
        uniqueUsers.map((user) =>
          this.prisma.teamOnUsers.upsert({
            where: {
              userId_teamId: { userId: user.userId, teamId: user.teamId },
            },
            create: user,
            update: { role: user.role },
          }),
        ),
      )
      .catch(() => {
        throw new InternalServerErrorException();
      });
  }

  /**
   * Quem entra na equipe tem que estar inscrito no evento. Os ids vêm do corpo
   * da requisição: sem esta conferência, um id de pessoa de outra igreja (ou de
   * quem nem se inscreveu) virava membro, e o nome dela passava a aparecer na
   * equipe e no PDF do evento.
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

  async create(idEvent: string, createTeam: TeammDto) {
    // fora do try: o catch genérico abaixo viraria um 500 sem explicação
    await this.assertUsersNoEvento(idEvent, [
      ...(createTeam.usersId ?? []),
      ...(createTeam.usersLeadersId ?? []),
    ]);

    try {
      const team = await this.prisma.team.create({
        data: {
          eventId: idEvent,
          name: createTeam.name,
          note: createTeam.note,
          capacity: createTeam.capacity,
        },
      });

      await this.createRelations(
        createTeam.usersLeadersId,
        createTeam.usersId,
        team.id,
      );
    } catch {
      throw new InternalServerErrorException();
    }
  }

  async findAll(eventId: string) {
    return await this.prisma.team
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
              role: true,
              user: {
                select: {
                  id: true,
                  fullName: true,
                  profilePhotoUrl: true,
                  cellphone: true,
                  birthday: true,
                  email: true,
                },
              },
            },
          },
        },
      })
      .then((teams) =>
        teams.map((team) => ({
          ...team,
          users: team.users.map((e) => ({ ...e.user, roleTeam: e.role })),
        })),
      );
  }

  /**
   * A equipe é procurada dentro do evento da URL. O `EventTenantGuard` garante
   * que o evento é da igreja de quem pediu; sem amarrar os dois, um id de
   * equipe de outra igreja passaria por aqui.
   */
  async findOne(id: string, eventId: string) {
    return await this.prisma.team
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
              role: true,
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
      .then((team) => ({
        ...team,
        users: team.users.map((e) => ({ ...e.user, roleTeam: e.role })),
      }));
  }

  async update(idEvent: string, idTeam: string, updateTeamDto: TeammDto) {
    await this.assertUsersNoEvento(idEvent, [
      ...(updateTeamDto.usersId ?? []),
      ...(updateTeamDto.usersLeadersId ?? []),
    ]);

    try {
      const teamExist = await this.prisma.team.findFirst({
        where: {
          id: idTeam,
          eventId: idEvent,
        },
      });

      if (!teamExist) {
        throw new NotFoundException('Team does not exists!');
      }

      await this.prisma.teamOnUsers.deleteMany({
        where: {
          teamId: idTeam,
          NOT: {
            userId: {
              in: [...updateTeamDto.usersId, ...updateTeamDto.usersLeadersId],
            },
          },
        },
      });

      const team = await this.prisma.team.update({
        data: {
          eventId: idEvent,
          name: updateTeamDto.name,
          note: updateTeamDto.note,
          capacity: updateTeamDto.capacity,
        },
        where: {
          id: idTeam,
        },
        include: {
          users: {
            select: {
              user: true,
            },
          },
        },
      });
      await this.createRelations(
        updateTeamDto.usersLeadersId,
        updateTeamDto.usersId,
        team.id,
      );
    } catch (erro) {
      // sem isto o "equipe não existe" saía como 500 sem explicação
      if (erro instanceof HttpException) throw erro;
      throw new InternalServerErrorException();
    }
  }

  async delete(teamId: string, eventId: string) {
    const bedroomExist = await this.prisma.team.findFirst({
      where: {
        id: teamId,
        eventId,
      },
    });

    if (!bedroomExist) {
      throw new NotFoundException('Team does not exist!');
    }

    // Delete relations
    await this.prisma.teamOnUsers.deleteMany({
      where: {
        teamId,
      },
    });

    // Deleta bedroom
    await this.prisma.team.delete({
      where: {
        id: teamId,
      },
    });
  }
}

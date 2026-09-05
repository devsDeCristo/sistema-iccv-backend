import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { UserDTO } from './dto/user.dto';
import {
  ADMIN_ROLES,
  ASSIGNABLE_ROLES,
  isDevRole,
  Role,
  isAdminRole,
} from 'src/auth/roles';
import { enviarEmailConfirmacao } from 'src/nodeMailer/sendEmail';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService, private jwtService: JwtService) {}

  async create(data: UserDTO) {
    const userCpfExists = await this.prisma.user.findFirst({
      where: {
        cpf: data.cpf,
      },
    });

    if (userCpfExists) {
      throw new ConflictException('Já existe um usuario com este cpf!');
    }

    try {
      data.birthday = new Date(data.birthday);
      // const eventId = data.eventId;
      // delete data.eventId;

      const user = await this.prisma.user.create({
        data: {
          ...data,
          // o cadastro é público: a permissão nunca vem do corpo da requisição.
          // Promoção de perfil só acontece pelo painel (PUT /users/:id por admin).
          role: Role.USER,
          password:
            '$2b$10$QGF/lucztAy.bqQFEQcSOOjP3fGMZfSsCIl4t.dfFo15Hh0v/C8xW',
        },
      });
      const payload = { username: user.cpf, sub: user.id };
      return {
        access_token: this.jwtService.sign(payload),
        user,
      };
      // let event = {};
      // if (eventId) {
      //   const hasEvent = await this.prisma.event.findFirst({
      //     where: { id: eventId },
      //   });

      //   if (hasEvent) {
      //     event = await this.prisma.eventOnUsers.create({
      //       data: {
      //         eventId,
      //         userId: user.id,
      //         paid: false,
      //       },
      //     });
      //   }
      // }
      // if (user && event) {
      //   await enviarEmailConfirmacao(user.fullName, user.email, user.worker);
      // }
    } catch (error) {
      throw new InternalServerErrorException();
    }
  }

  // async createRelationEvent(
  //   idUser: string,
  //   idEvent: string,
  //   registrationTypeId: string,
  // ) {
  //   const user = await this.prisma.user.findFirst({
  //     where: { id: idUser },
  //   });

  //   if (!user) {
  //     throw new NotFoundException('Usuário não encontrado!');
  //   }

  //   if (!idEvent) {
  //     throw new BadRequestException('ID do evento não fornecido!');
  //   }

  //   const hasEvent = await this.prisma.event.findFirst({
  //     where: { id: idEvent },
  //   });

  //   if (!hasEvent) {
  //     throw new NotFoundException('Evento não encontrado!');
  //   }

  //   const hasRelationEventOnUser = await this.prisma.eventOnUsers.findFirst({
  //     where: { userId: user.id, eventId: idEvent },
  //   });

  //   if (hasRelationEventOnUser) {
  //     throw new ConflictException('Usuário já está inscrito neste evento!');
  //   }

  //   const event = await this.prisma.eventOnUsers.create({
  //     data: {
  //       eventId: idEvent,
  //       userId: user.id,
  //       registrationTypeId,
  //     },
  //   });

  //   await enviarEmailConfirmacao(
  //     user.fullName,
  //     user.email,
  //     false, // mudar
  //     hasEvent.name,
  //     hasEvent.startDate,
  //     hasEvent.endDate,
  //   );

  //   return event;
  // }

  /**
   * A conta dev só é alterada por outro dev. Rebaixar, trocar dados pessoais ou
   * mexer na foto são todos caminhos para tomar a conta ou para se passar por
   * ela, então a checagem é do alvo, não do campo.
   */
  private assertDevAccountIsUntouchable(
    targetRole?: number | null,
    requesterRole?: number | null,
  ) {
    if (isDevRole(targetRole) && !isDevRole(requesterRole)) {
      throw new ForbiddenException(
        'Somente o perfil Dev pode alterar uma conta Dev',
      );
    }
  }

  async setProfilePhoto(
    id: string,
    photoUrl: string,
    requesterId?: string,
  ): Promise<UserDTO> {
    if (requesterId) {
      const [target, requester] = await Promise.all([
        this.prisma.user.findUnique({ where: { id }, select: { role: true } }),
        this.prisma.user.findUnique({
          where: { id: requesterId },
          select: { role: true },
        }),
      ]);

      this.assertDevAccountIsUntouchable(target?.role, requester?.role);
    }

    return this.prisma.user.update({
      where: { id },
      data: { profilePhotoUrl: photoUrl },
    });
  }

  async findAll(filters?: Partial<UserDTO>) {
    const users = await this.prisma.user.findMany({
      where: {
        fullName: { contains: filters?.fullName || undefined },
        email: { contains: filters?.email || undefined },
      },
      orderBy: {
        role: 'asc',
      },
      include: {
        events: {
          include: {
            event: {
              select: {
                id: true,
                name: true,
                status: true,
              },
            },
          },
        },
      },
    });

    return users;
  }

  async findByDocument(document: string) {
    if (!document) return null;
    return this.prisma.user.findUnique({ where: { cpf: document } });
  }

  async findOne(id: string) {
    return this.prisma.user.findFirst({ where: { id } });
  }

  /**
   * @param requesterId usuário autenticado que disparou a edição. Quando ausente
   * (chamada interna), nenhuma restrição de permissão é aplicada.
   */
  async update(id: string, data: UserDTO, requesterId?: string) {
    const userExists = await this.prisma.user.findUnique({
      where: {
        id,
      },
    });

    if (!userExists) {
      throw new NotFoundException('User does not exists!');
    }

    if (requesterId) {
      const requester = await this.prisma.user.findUnique({
        where: { id: requesterId },
        select: { role: true },
      });

      const requesterIsAdmin = isAdminRole(requester?.role);
      const requesterIsDev = isDevRole(requester?.role);

      // usuário comum só edita o próprio cadastro
      if (!requesterIsAdmin && requesterId !== id) {
        throw new ForbiddenException('Você só pode editar o seu cadastro');
      }

      // Nenhum campo da conta dev, e não só o `role`: com o e-mail trocado, um
      // super admin pediria a redefinição de senha pelo CPF do dev
      // (POST /auth/password/request, que envia o código para o e-mail
      // gravado) e assumiria a conta sem nunca tocar na permissão.
      this.assertDevAccountIsUntouchable(userExists.role, requester?.role);

      // só admin altera permissão — para os demais o campo é ignorado,
      // já que o formulário de perfil devolve o usuário inteiro no payload
      if (!requesterIsAdmin) {
        delete data.role;
      } else if (
        data.role !== undefined &&
        !ASSIGNABLE_ROLES.includes(data.role)
      ) {
        throw new BadRequestException('Permissão inválida');
      } else if (data.role === Role.DEV && !requesterIsDev) {
        // Promover alguém a dev também é privilégio de dev — senão qualquer
        // admin criaria um dev e entraria pela porta que acabamos de trancar.
        throw new ForbiddenException(
          'Apenas o perfil Dev pode conceder o acesso Dev',
        );
      }
    }

    // Senha não passa por aqui: `data` vai direto para o Prisma, então uma
    // senha no corpo seria gravada em texto puro e nenhum login voltaria a
    // funcionar. Quem troca senha é o fluxo de redefinição
    // (POST /auth/password/*), que grava o hash bcrypt.
    delete data.password;

    // const existEventRelation = await this.prisma.eventOnUsers.findFirst({
    //   where: { userId: id, eventId: data.eventId },
    // });

    try {
      // data.birthday = new Date(data.birthday);
      // const eventId = data.eventId;
      // delete data.eventId;

      await this.prisma.user.update({
        data,
        where: {
          id,
        },
      });

      // if (eventId && !existEventRelation) {
      //   await this.prisma.eventOnUsers.create({
      //     data: {
      //       eventId,
      //       userId: id,
      //       paid: false,
      //     },
      //   });
      // }
    } catch (error) {
      console.log(error);
      throw new InternalServerErrorException();
    }
  }
  async findInsightsEvents() {
    // verifica quais usuarios tem recorrencia em eventos em um ano
    const currentYear = new Date().getFullYear() - 1;
    const usersWithEvents = await this.prisma.user.count({
      where: {
        events: {
          some: {
            event: {
              startDate: {
                gte: new Date(`${currentYear}-01-01`),
                lt: new Date(`${currentYear + 1}-01-01`),
              },
            },
          },
        },
      },
    });
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        role: true,
      },
    });

    return {
      totalUsers: users.length,
      totalUsersAdmin: users.filter((user) => ADMIN_ROLES.includes(user.role))
        .length,
      usersWithEvents,
    };
  }
  async findUserGroups(userId: string) {
    const [presentGroups, waitlistGroups] = await Promise.all([
      // Grupos onde o usuário está confirmado (inscrito)
      this.prisma.groupRoles.findMany({
        where: {
          roles: {
            some: {
              EventOnUsers: {
                some: { userId },
              },
            },
          },
        },
      }),

      // Grupos onde o usuário está na lista de espera
      this.prisma.groupRoles.findMany({
        where: {
          roles: {
            some: {
              Waitlist: {
                some: { userId },
              },
            },
          },
        },
      }),
    ]);

    return {
      present: presentGroups,
      waitlist: waitlistGroups,
    };
  }
}

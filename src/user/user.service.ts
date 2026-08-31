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
  ADMIN_AREA_ROLES,
  ADMIN_ROLES,
  ASSIGNABLE_ROLES,
  Role,
  isAdminRole,
} from 'src/auth/roles';
import { enviarEmailConfirmacao } from 'src/nodeMailer/sendEmail';
import { JwtService } from '@nestjs/jwt';
import { tenantChurchId, userChurchScope } from 'src/auth/tenant';

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

      // a igreja também não vem do corpo: quem se cadastra não escolhe o
      // tenant a que pertence — isso é definido na primeira inscrição em evento
      delete data.churchId;

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

  async setProfilePhoto(
    id: string,
    photoUrl: string,
    requesterId?: string,
  ): Promise<UserDTO> {
    await this.assertCanReachUser(requesterId, id);

    return this.prisma.user.update({
      where: { id },
      data: { profilePhotoUrl: photoUrl },
    });
  }

  /**
   * @param requesterId admin que pediu a lista. Sem ele nenhum recorte é
   * aplicado (chamada interna).
   */
  async findAll(filters?: Partial<UserDTO>, requesterId?: string) {
    const requester = requesterId ? await this.getRequester(requesterId) : null;
    const churchId = tenantChurchId(requester);

    const users = await this.prisma.user.findMany({
      where: {
        fullName: { contains: filters?.fullName || undefined },
        email: { contains: filters?.email || undefined },
        ...userChurchScope(requester),
      },
      orderBy: {
        role: 'asc',
      },
      include: {
        // igreja de quem entra no painel: é o que diferencia um admin do outro
        // na lista do super admin, que enxerga os de todas
        church: { select: { id: true, name: true } },
        events: {
          // quem participa de evento de outra igreja entra na lista pelo
          // vínculo local, mas o evento de lá não aparece junto
          where: churchId ? { event: { churchId } } : undefined,
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

  /**
   * @param requesterId quem pediu o cadastro. Usuário comum só lê o próprio;
   * o painel lê quem estiver na sua igreja.
   */
  async findOne(id: string, requesterId?: string) {
    await this.assertCanReachUser(requesterId, id);

    const user = await this.prisma.user.findFirst({ where: { id } });
    if (!user) return null;

    // `password` fica de fora: a rota é aberta a qualquer autenticado e o hash
    // não tem por que sair do banco.
    const { password: _password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  private async assertChurchExists(churchId: string) {
    const church = await this.prisma.church.findUnique({
      where: { id: churchId },
      select: { id: true },
    });

    if (!church) {
      throw new BadRequestException('Igreja não encontrada');
    }
  }

  /**
   * Dado de pessoa só sai para ela mesma ou para o painel da igreja dela.
   * Sem `requesterId` (chamada interna) nada é checado.
   */
  private async assertCanReachUser(
    requesterId: string | undefined,
    targetId: string,
  ) {
    if (!requesterId || requesterId === targetId) return;

    const requester = await this.getRequester(requesterId);

    if (!ADMIN_AREA_ROLES.includes(requester?.role as Role)) {
      throw new ForbiddenException('Você só pode ver o seu cadastro');
    }

    await this.assertUserInScope(requester, targetId);
  }

  private async getRequester(requesterId: string) {
    return this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { role: true, churchId: true },
    });
  }

  /** Barra o admin que tenta alcançar alguém de outra igreja. */
  private async assertUserInScope(
    requester: { role?: number | null; churchId?: string | null } | null,
    targetId: string,
  ) {
    const scope = userChurchScope(requester);
    if (!Object.keys(scope).length) return;

    const alcancavel = await this.prisma.user.findFirst({
      where: { id: targetId, ...scope },
      select: { id: true },
    });

    if (!alcancavel) {
      throw new ForbiddenException('Este usuário é de outra igreja');
    }
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
      const requester = await this.getRequester(requesterId);

      const requesterIsAdmin = isAdminRole(requester?.role);
      const requesterIsSuperAdmin = requester?.role === Role.SUPER_ADMIN;

      // usuário comum só edita o próprio cadastro
      if (!requesterIsAdmin && requesterId !== id) {
        throw new ForbiddenException('Você só pode editar o seu cadastro');
      }

      // só admin altera permissão — para os demais o campo é ignorado,
      // já que o formulário de perfil devolve o usuário inteiro no payload
      if (!requesterIsAdmin) {
        delete data.role;
        delete data.churchId;
      } else {
        if (!requesterIsSuperAdmin) {
          // o super admin não é editável por quem está abaixo dele: sem esta
          // linha um admin rebaixaria o dono do sistema
          if (userExists.role === Role.SUPER_ADMIN) {
            throw new ForbiddenException(
              'Somente o super admin edita outro super admin',
            );
          }

          await this.assertUserInScope(requester, id);
        }

        if (data.role !== undefined) {
          if (!ASSIGNABLE_ROLES.includes(data.role)) {
            throw new BadRequestException('Permissão inválida');
          }

          // o perfil de super admin não se concede a si mesmo: sem esta trava
          // qualquer admin virava super admin com um PUT no próprio id
          if (data.role === Role.SUPER_ADMIN && !requesterIsSuperAdmin) {
            throw new ForbiddenException(
              'Somente o super admin concede o perfil de super admin',
            );
          }
        }

        // a igreja de quem entra no painel é obrigatória — é ela que recorta
        // tudo o que a pessoa vai enxergar. O super admin é a exceção: ele
        // atravessa todas, então não fica preso a nenhuma
        if (data.role === Role.SUPER_ADMIN) {
          data.churchId = null;
        } else if (
          data.role !== undefined &&
          ADMIN_AREA_ROLES.includes(data.role)
        ) {
          if (requesterIsSuperAdmin) {
            const churchId = data.churchId ?? userExists.churchId;

            if (!churchId) {
              throw new BadRequestException(
                'Informe a igreja do administrador',
              );
            }

            await this.assertChurchExists(churchId);
            data.churchId = churchId;
          } else {
            // admin de igreja só cria gente da própria igreja
            if (!requester?.churchId) {
              throw new ForbiddenException(
                'Admin sem igreja associada não pode criar outros admins',
              );
            }
            data.churchId = requester.churchId;
          }
        } else if (data.role === Role.USER) {
          // saiu do painel: usuário comum não pertence a igreja nenhuma, o que
          // o liga a cada uma são as inscrições em eventos
          data.churchId = null;
        } else if (!requesterIsSuperAdmin) {
          // mudar alguém de igreja é privilégio do super admin
          delete data.churchId;
        } else if (data.churchId) {
          await this.assertChurchExists(data.churchId);
        }
      }
    }

    // Senha não passa por aqui: `data` vai direto para o Prisma, então uma
    // senha no corpo seria gravada em texto puro e nenhum login voltaria a
    // funcionar. Quem troca senha é o fluxo de redefinição
    // (POST /auth/password/*), que grava o hash bcrypt.
    delete data.password;

    try {
      await this.prisma.user.update({
        data,
        where: {
          id,
        },
      });
    } catch (error) {
      console.log(error);
      throw new InternalServerErrorException();
    }
  }
  async findInsightsEvents(requesterId?: string) {
    const requester = requesterId ? await this.getRequester(requesterId) : null;
    // os números do painel são da igreja de quem está olhando
    const scope = userChurchScope(requester);

    // verifica quais usuarios tem recorrencia em eventos em um ano
    const currentYear = new Date().getFullYear() - 1;
    const usersWithEvents = await this.prisma.user.count({
      where: {
        ...scope,
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
      where: scope,
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
  async findUserGroups(userId: string, requesterId?: string) {
    await this.assertCanReachUser(requesterId, userId);

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

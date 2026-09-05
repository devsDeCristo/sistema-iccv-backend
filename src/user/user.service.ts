import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { UserDTO } from './dto/user.dto';
import {
  ADMIN_AREA_ROLES,
  ADMIN_ROLES,
  CHURCH_ROLES,
  Role,
  SUPER_ADMIN_ROLES,
  isAdminRole,
  isDevRole,
} from 'src/auth/roles';
import { enviarEmailConfirmacao } from 'src/nodeMailer/sendEmail';
import { JwtService } from '@nestjs/jwt';
import {
  SELECT_TENANT,
  TenantRequester,
  VinculoDeIgreja,
  churchIdsComPerfil,
  isSuperAdmin,
  tenantChurchIds,
  userChurchScope,
} from 'src/auth/tenant';

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

      // nem igreja nem permissão vêm do corpo: o cadastro é público, e quem se
      // cadastra não escolhe o tenant nem o próprio perfil
      const {
        churchId: _lente,
        churchRoles: _vinculos,
        ...cadastro
      } = data;

      const user = await this.prisma.user.create({
        data: {
          ...cadastro,
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
   *
   * É uma trava separada do recorte por igreja: o dev não pertence a igreja
   * nenhuma, então `assertCanReachUser` sozinho não o protege de um super
   * admin, que atravessa todas.
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

  /** Mesma trava, quando só os ids estão em mãos */
  private async assertDevAccountIsUntouchableById(
    requesterId: string | undefined,
    targetId: string,
  ) {
    if (!requesterId) return;

    const [target, requester] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: targetId },
        select: { role: true },
      }),
      this.prisma.user.findUnique({
        where: { id: requesterId },
        select: { role: true },
      }),
    ]);

    this.assertDevAccountIsUntouchable(target?.role, requester?.role);
  }

  async setProfilePhoto(
    id: string,
    photoUrl: string,
    requesterId?: string,
  ): Promise<UserDTO> {
    // as duas travas: a igreja diz quem o admin alcança, e a do dev protege
    // uma conta que não pertence a igreja nenhuma
    await this.assertCanReachUser(requesterId, id);
    await this.assertDevAccountIsUntouchableById(requesterId, id);

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

    /**
     * Lente de igreja: a lista responde como se quem pediu fosse admin só
     * daquela igreja. Serve ao super admin, que enxerga todas, e a quem
     * administra mais de uma e quer olhar uma de cada vez.
     *
     * Igreja que a pessoa não alcança é ignorada — a lente estreita o recorte,
     * nunca amplia.
     */
    // gerenciar pessoas é trabalho de admin: as igrejas onde ela é só
    // financeiro não entram na lista
    const alcance = churchIdsComPerfil(requester, [Role.ADMIN]);
    const podeUsarLente =
      !!filters?.churchId &&
      (isSuperAdmin(requester) || alcance.includes(filters.churchId));

    const lente = podeUsarLente
      ? userChurchScope({
          role: Role.ADMIN,
          churchRoles: [
            { churchId: filters!.churchId as string, role: Role.ADMIN },
          ],
        })
      : {};

    const recortes = [userChurchScope(requester, [Role.ADMIN]), lente].filter(
      (recorte) => Object.keys(recorte).length > 0,
    );

    // as igrejas que mandam nos eventos mostrados em cada linha: as do admin
    // ou, para o super admin, a que ele escolheu na lente
    const churchIds = podeUsarLente
      ? [filters!.churchId as string]
      : tenantChurchIds(requester, [Role.ADMIN]);

    const users = await this.prisma.user.findMany({
      where: {
        fullName: { contains: filters?.fullName || undefined },
        email: { contains: filters?.email || undefined },
        // `AND` e não espalhar os dois: ambos usam a chave `OR` e um
        // sobrescreveria o outro no objeto
        ...(recortes.length ? { AND: recortes } : {}),
      },
      orderBy: {
        role: 'asc',
      },
      include: {
        // os vínculos de painel: é o que diferencia um admin do outro na lista
        // do super admin, que enxerga os de todas as igrejas
        churchRoles: {
          select: {
            role: true,
            church: { select: { id: true, name: true } },
          },
        },
        events: {
          // quem participa de evento de outra igreja entra na lista pelo
          // vínculo local, mas o evento de lá não aparece junto
          where: churchIds ? { event: { churchId: { in: churchIds } } } : undefined,
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

    // os vínculos vão junto: é com eles que o painel monta o que a pessoa
    // administra em cada igreja logo depois do login
    return this.prisma.user.findUnique({
      where: { cpf: document },
      include: {
        churchRoles: {
          select: { role: true, church: { select: { id: true, name: true } } },
        },
      },
    });
  }

  /**
   * @param requesterId quem pediu o cadastro. Usuário comum só lê o próprio;
   * o painel lê quem estiver na sua igreja.
   */
  async findOne(id: string, requesterId?: string) {
    await this.assertCanReachUser(requesterId, id);

    const user = await this.prisma.user.findFirst({
      where: { id },
      include: {
        // o painel precisa saber em quais igrejas a pessoa trabalha
        churchRoles: {
          select: { role: true, church: { select: { id: true, name: true } } },
        },
      },
    });
    if (!user) return null;

    // `password` fica de fora: a rota é aberta a qualquer autenticado e o hash
    // não tem por que sair do banco.
    const { password: _password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Perfil efetivo da pessoa: super admin manda, senão vale o mais alto dos
   * vínculos, e sem vínculo nenhum ela é usuário comum. É o que os guards de
   * rota leem para saber se ela pode chegar na rota; em qual igreja, quem
   * responde são os vínculos.
   */
  private perfilEfetivo(pessoa: TenantRequester | null): number {
    if (!pessoa) return Role.USER;

    // Dev e super admin são perfis globais: não derivam de vínculo e não podem
    // ser rebaixados pelo recálculo. Sem o dev nesta linha, ele não casava com
    // nenhum vínculo, caía em `Role.USER` e perdia o acesso na primeira vez que
    // alguém salvasse o cadastro dele — inclusive ele mesmo.
    if (SUPER_ADMIN_ROLES.includes(pessoa.role as Role)) {
      return pessoa.role as Role;
    }

    const perfis = (pessoa.churchRoles ?? []).map((vinculo) => vinculo.role);

    if (perfis.includes(Role.ADMIN)) return Role.ADMIN;
    if (perfis.includes(Role.FINANCE)) return Role.FINANCE;

    return Role.USER;
  }

  /**
   * Monta a lista de vínculos que vai substituir a atual.
   *
   * O super admin define a lista inteira. O admin só mexe nas igrejas que ele
   * administra: os vínculos da pessoa nas outras são preservados como estão —
   * sem isso, um admin de uma igreja apagaria, sem querer ou de propósito, a
   * permissão que a pessoa tem na igreja vizinha.
   */
  private async resolveVinculos(
    requester: TenantRequester | null,
    targetId: string,
    pedidos: VinculoDeIgreja[],
  ): Promise<VinculoDeIgreja[]> {
    const limpos = (pedidos ?? []).map((vinculo) => ({
      churchId: vinculo.churchId,
      role: Number(vinculo.role),
    }));

    if (limpos.some((vinculo) => !CHURCH_ROLES.includes(vinculo.role))) {
      throw new BadRequestException(
        'Só admin e financeiro são perfis de igreja',
      );
    }

    const igrejas = limpos.map((vinculo) => vinculo.churchId);
    if (new Set(igrejas).size !== igrejas.length) {
      throw new BadRequestException(
        'Cada igreja aceita um perfil só por pessoa',
      );
    }

    if (igrejas.length) {
      const existentes = await this.prisma.church.count({
        where: { id: { in: igrejas } },
      });

      if (existentes !== new Set(igrejas).size) {
        throw new BadRequestException('Igreja não encontrada');
      }
    }

    if (isSuperAdmin(requester)) return limpos;

    const minhas = churchIdsComPerfil(requester, [Role.ADMIN]);

    if (!minhas.length) {
      throw new ForbiddenException(
        'Você não administra nenhuma igreja para dar permissões',
      );
    }

    const forasteira = igrejas.find((churchId) => !minhas.includes(churchId));
    if (forasteira) {
      throw new ForbiddenException(
        'Você só dá permissão nas igrejas que administra',
      );
    }

    const atuais = await this.prisma.userChurchRole.findMany({
      where: { userId: targetId },
      select: { churchId: true, role: true },
    });

    const preservados = atuais.filter(
      (vinculo) => !minhas.includes(vinculo.churchId),
    );

    return [...preservados, ...limpos];
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
      select: SELECT_TENANT,
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

    /** vínculos a gravar; `undefined` significa "não mexi neles" */
    let vinculosParaSalvar: VinculoDeIgreja[] | undefined;

    if (requesterId) {
      const requester = await this.getRequester(requesterId);

      const requesterIsAdmin = isAdminRole(requester?.role);
      const requesterIsDev = isDevRole(requester?.role);
      // o dev entra aqui junto com o super admin: ele tem o mesmo poder, e sem
      // isso não editaria quem administra o sistema nem concederia vínculos
      const requesterIsSuperAdmin = SUPER_ADMIN_ROLES.includes(
        requester?.role as Role,
      );

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
        delete data.churchRoles;
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

        // o perfil global só tem três valores: dev, super admin e usuário
        // comum. Admin e financeiro moram nos vínculos, um por igreja.
        if (data.role !== undefined) {
          if (
            ![Role.DEV, Role.SUPER_ADMIN, Role.USER].includes(data.role)
          ) {
            throw new BadRequestException(
              'Admin e financeiro são definidos por igreja, em churchRoles',
            );
          }

          // o perfil de super admin não se concede a si mesmo: sem esta trava
          // qualquer admin virava super admin com um PUT no próprio id
          if (data.role === Role.SUPER_ADMIN && !requesterIsSuperAdmin) {
            throw new ForbiddenException(
              'Somente o super admin concede o perfil de super admin',
            );
          }

          // conceder dev é privilégio de dev, e não de super admin: senão
          // qualquer super admin criaria um dev e entraria pela porta que a
          // trava de conta dev acabou de fechar
          if (data.role === Role.DEV && !requesterIsDev) {
            throw new ForbiddenException(
              'Apenas o perfil Dev pode conceder o acesso Dev',
            );
          }
        }

        if (data.churchRoles !== undefined) {
          vinculosParaSalvar = await this.resolveVinculos(
            requester,
            id,
            data.churchRoles,
          );
        }
      }
    }

    /**
     * Sai tudo o que não é coluna de `users`:
     *
     * - `churchRoles` virou tabela própria e é gravado logo abaixo;
     * - `churchId` hoje é só a lente da listagem;
     * - a senha nunca passa por aqui — iria em texto puro e nenhum login
     *   voltaria a funcionar. Quem troca senha é `POST /auth/password/*`, que
     *   grava o hash bcrypt.
     */
    const {
      churchRoles: _vinculosDoCorpo,
      churchId: _lenteDoCorpo,
      password: _senha,
      ...campos
    } = data;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ data: campos, where: { id } });

        if (vinculosParaSalvar !== undefined) {
          await tx.userChurchRole.deleteMany({ where: { userId: id } });

          if (vinculosParaSalvar.length) {
            await tx.userChurchRole.createMany({
              data: vinculosParaSalvar.map((vinculo) => ({
                userId: id,
                churchId: vinculo.churchId,
                role: vinculo.role,
              })),
            });
          }
        }

        // `role` é derivado: fica sempre igual ao mais alto dos vínculos, na
        // mesma transação que os escreve. É ele que os guards de rota leem, e
        // duas fontes divergindo é como uma permissão sobra ou some sem
        // ninguém pedir.
        const atual = await tx.user.findUnique({
          where: { id },
          select: SELECT_TENANT,
        });

        const efetivo = this.perfilEfetivo(atual);

        if (atual && atual.role !== efetivo) {
          await tx.user.update({ where: { id }, data: { role: efetivo } });
        }
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.log(error);
      throw new InternalServerErrorException();
    }
  }
  async findInsightsEvents(requesterId?: string) {
    const requester = requesterId ? await this.getRequester(requesterId) : null;
    // os números da tela de usuários seguem o mesmo recorte da lista
    const scope = userChurchScope(requester, [Role.ADMIN]);

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

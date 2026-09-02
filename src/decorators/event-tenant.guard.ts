import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma';
import { CHURCH_ROLES, Role } from 'src/auth/roles';
import { SELECT_TENANT, tenantChurchIds } from 'src/auth/tenant';
import { ROLES_KEY } from './roles.decorator';

/**
 * Fecha as rotas penduradas em um evento (`/events/:idEvent/...`, pagamentos,
 * check-in, quartos, equipes) para quem não administra a igreja daquele evento.
 *
 * É aqui que a permissão por igreja é cobrada de verdade. O `RolesGuard` só
 * responde "esta pessoa pode chegar nesta rota em alguma igreja?"; quem é admin
 * numa e financeiro noutra passaria por ele com o perfil mais alto. Este guard
 * pergunta o resto: o perfil que a rota exige, ela tem **nesta** igreja?
 *
 * Como o `RolesGuard`, o vínculo é lido do banco e não do JWT — o token dura
 * 24h e guardaria a permissão antiga depois de uma mudança.
 */
@Injectable()
export class EventTenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }

    const requester = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SELECT_TENANT,
    });

    if (!requester) {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    // rota sobre o próprio cadastro (inscrever-se, pagar a própria inscrição) é
    // área do usuário: ali quem administra é um inscrito como outro qualquer e
    // pode entrar em evento de qualquer igreja. O recorte vale quando ele mexe
    // na inscrição de outra pessoa, que é trabalho de painel.
    if (request.params?.idUser && request.params.idUser === userId) return true;

    const perfisAceitos = this.perfisDaRota(context);
    const churchIds = tenantChurchIds(requester, perfisAceitos);

    // super admin e usuário comum não são recortados
    if (churchIds === null) return true;

    const eventId = await this.resolveEventId(request);
    if (!eventId) return true;

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { churchId: true },
    });

    if (!event) {
      throw new NotFoundException('Event does not exist');
    }

    if (!churchIds.includes(event.churchId)) {
      throw new ForbiddenException(
        'Você não tem esta permissão na igreja deste evento',
      );
    }

    // evita a segunda consulta nos services que também precisam do vínculo
    request.user.role = requester.role;
    request.user.churchRoles = requester.churchRoles;

    return true;
  }

  /**
   * Perfis de igreja que a rota exige. `@Roles(...ADMIN_ROLES)` vira "admin
   * naquela igreja"; `@Roles(...ADMIN_AREA_ROLES)` aceita o financeiro também.
   * Rota sem `@Roles` (a inscrição, por exemplo) aceita qualquer vínculo.
   */
  private perfisDaRota(context: ExecutionContext): number[] {
    const exigidos =
      this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const deIgreja = exigidos.filter((perfil) =>
      CHURCH_ROLES.includes(perfil as Role),
    );

    return deIgreja.length ? deIgreja : CHURCH_ROLES;
  }

  /**
   * O evento aparece na URL como `:idEvent` ou `:eventId`. As rotas de
   * pagamento identificam o recurso só pelo `:paymentId`, então ali o evento
   * sai do próprio pagamento.
   */
  private async resolveEventId(request: any): Promise<string | null> {
    const fromParams = request.params?.idEvent ?? request.params?.eventId;
    if (fromParams) return fromParams;

    const paymentId = request.params?.paymentId;
    if (paymentId) {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: { eventId: true },
      });

      if (!payment) {
        throw new NotFoundException('Pagamento não encontrado');
      }

      return payment.eventId;
    }

    return null;
  }
}

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { assertSameChurch, isTenantScoped } from 'src/auth/tenant';

/**
 * Fecha as rotas penduradas em um evento (`/events/:idEvent/...`, pagamentos,
 * check-in, quartos, equipes) para quem é de outra igreja.
 *
 * Sem ela cada controller dependeria de lembrar da checagem, e o `idEvent` vem
 * da URL: bastava trocar o id na mão para um admin operar o evento da igreja
 * vizinha, mesmo com o `@Roles` correto.
 *
 * Como o `RolesGuard`, o perfil é lido do banco e não do JWT — o token dura 24h
 * e guardaria a igreja antiga depois de uma troca de vínculo.
 */
@Injectable()
export class EventTenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }

    const requester = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, churchId: true },
    });

    if (!requester) {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    // super admin atravessa tudo; usuário comum se inscreve em evento de
    // qualquer igreja, então nenhum dos dois é recortado aqui
    if (!isTenantScoped(requester.role)) return true;

    // rota sobre o próprio cadastro (inscrever-se, pagar a própria inscrição) é
    // área do usuário: ali o admin é um inscrito como outro qualquer e pode
    // entrar em evento de qualquer igreja. O recorte vale quando ele mexe na
    // inscrição de outra pessoa, que é trabalho de painel.
    if (request.params?.idUser && request.params.idUser === userId) return true;

    const eventId = await this.resolveEventId(request);
    if (!eventId) return true;

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { churchId: true },
    });

    if (!event) {
      throw new NotFoundException('Event does not exist');
    }

    assertSameChurch(
      requester,
      event.churchId,
      'Você não tem acesso a eventos de outra igreja',
    );

    // evita a segunda consulta nos services que também precisam do vínculo
    request.user.role = requester.role;
    request.user.churchId = requester.churchId;

    return true;
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

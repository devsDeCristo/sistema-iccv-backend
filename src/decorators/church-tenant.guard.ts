import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma';
import { CHURCH_ROLES, Role } from 'src/auth/roles';
import { assertChurchAccess, SELECT_TENANT } from 'src/auth/tenant';
import {
  ACEITA_TESOUREIRO_KEY,
  tesoureiroNaIgreja,
} from 'src/auth/tesoureiro-do-evento';
import {
  ACEITA_ADMIN_DO_EVENTO_KEY,
  adminDeEventoNaIgreja,
} from 'src/auth/admin-do-evento';
import { ROLES_KEY } from './roles.decorator';

/**
 * Irmão do `EventTenantGuard`, para as rotas cujo tenant está no próprio
 * caminho: `/churches/:churchId/...`.
 *
 * O `EventTenantGuard` chega na igreja pelo evento. Aqui não há evento — a
 * configuração de cobrança é da igreja, não de um evento dela —, e sem um
 * guard próprio bastaria trocar o `:churchId` da URL para um admin cadastrar
 * a credencial de cobrança da igreja vizinha e passar a receber o dinheiro
 * dela. É a rota mais sensível do sistema; o recorte vem antes de tudo.
 *
 * Como no outro, o vínculo é lido do banco e não do JWT: o token dura 24h e
 * guardaria a permissão de antes de a pessoa ser removida.
 */
@Injectable()
export class ChurchTenantGuard implements CanActivate {
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

    const churchId =
      request.params?.churchId ?? request.params?.idChurch ?? null;

    // Rota sem igreja no caminho (o catálogo de integrações, por exemplo):
    // não há o que recortar, e o `@Roles` já respondeu quem entra.
    if (!churchId) return true;

    const requester = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SELECT_TENANT,
    });

    if (!requester) {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    const church = await this.prisma.church.findUnique({
      where: { id: churchId },
      select: { id: true },
    });

    if (!church) {
      throw new NotFoundException('Igreja não encontrada');
    }

    try {
      assertChurchAccess(requester, churchId, {
        roles: this.perfisDaRota(context),
        message: 'Você não administra esta igreja',
      });
    } catch (erro) {
      // a rota que aceita o tesoureiro(a) ou o admin de evento abre para quem
      // é um deles num evento **desta** igreja — e só para ele
      const marcada = (chave: string) =>
        this.reflector.getAllAndOverride<boolean>(chave, [
          context.getHandler(),
          context.getClass(),
        ]);
      const comoTesoureiro =
        marcada(ACEITA_TESOUREIRO_KEY) &&
        (await tesoureiroNaIgreja(this.prisma, userId, churchId));
      const comoAdminDeEvento =
        marcada(ACEITA_ADMIN_DO_EVENTO_KEY) &&
        (await adminDeEventoNaIgreja(this.prisma, userId, churchId));
      if (!comoTesoureiro && !comoAdminDeEvento) throw erro;
    }

    // evita a segunda consulta nos services que também precisam do vínculo
    request.user.role = requester.role;
    request.user.churchRoles = requester.churchRoles;

    return true;
  }

  /**
   * Perfis de igreja exigidos pela rota. `@Roles(...ADMIN_ROLES)` cobra "admin
   * **nesta** igreja" e deixa a tesouraria de fora — que é o desenho pedido
   * para a configuração de cobrança: quem dá baixa em pagamento não é quem
   * decide para qual conta o dinheiro vai.
   */
  private perfisDaRota(context: ExecutionContext): number[] {
    const exigidos =
      this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const deIgreja = exigidos.filter((perfil) => CHURCH_ROLES.includes(perfil));

    return deIgreja.length ? deIgreja : CHURCH_ROLES;
  }
}

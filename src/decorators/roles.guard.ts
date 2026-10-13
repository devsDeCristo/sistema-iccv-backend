import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma';
import { Role } from 'src/auth/roles';
import { perfilEfetivo, SELECT_TENANT } from 'src/auth/tenant';
import {
  ACEITA_TESOUREIRO_KEY,
  temVinculoDeTesoureiro,
} from 'src/auth/tesoureiro-do-evento';
import {
  ACEITA_ADMIN_DO_EVENTO_KEY,
  temVinculoDeAdminDeEvento,
} from 'src/auth/admin-do-evento';
import { ROLES_KEY } from './roles.decorator';

/**
 * Libera a rota apenas para os perfis declarados em `@Roles(...)`.
 *
 * O perfil é lido do banco (e não do JWT) de propósito: o token dura 24h, então
 * ler do payload manteria um usuário rebaixado com acesso de admin até o token
 * expirar. É uma busca por chave primária, irrelevante perto das queries destas rotas.
 *
 * E vale o perfil efetivo, calculado dos vínculos que valem, não o `User.role`
 * gravado: quem só administra igreja desativada é usuário comum, mesmo que o
 * gravado ainda diga admin.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // rota sem @Roles() continua valendo para qualquer usuário autenticado
    if (!requiredRoles?.length) return true;

    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }

    const pessoa = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SELECT_TENANT,
    });

    if (!pessoa) {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    const user = { role: perfilEfetivo(pessoa) };

    const marcada = (chave: string) =>
      this.reflector.getAllAndOverride<boolean>(chave, [
        context.getHandler(),
        context.getClass(),
      ]);

    /**
     * Fora dos perfis da rota, só passa o tesoureiro(a) de evento, e o admin
     * de evento em rota que aceita admin — cada um só em rota que o aceita.
     * Aqui basta ter algum vínculo: se é deste evento, quem responde é o
     * `EventTenantGuard` (ou o `ChurchTenantGuard`), que vem depois.
     */
    if (
      !requiredRoles.includes(user.role as Role) &&
      !(
        marcada(ACEITA_TESOUREIRO_KEY) &&
        (await temVinculoDeTesoureiro(this.prisma, userId))
      ) &&
      !(
        requiredRoles.includes(Role.ADMIN) &&
        marcada(ACEITA_ADMIN_DO_EVENTO_KEY) &&
        (await temVinculoDeAdminDeEvento(this.prisma, userId))
      )
    ) {
      throw new ForbiddenException(
        'Você não tem permissão para acessar este recurso',
      );
    }

    // deixa o perfil disponível para os controllers sem nova consulta
    request.user.role = user.role;

    return true;
  }
}

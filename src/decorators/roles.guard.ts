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
import { ROLES_KEY } from './roles.decorator';

/**
 * Libera a rota apenas para os perfis declarados em `@Roles(...)`.
 *
 * O perfil é lido do banco (e não do JWT) de propósito: o token dura 24h, então
 * ler do payload manteria um usuário rebaixado com acesso de admin até o token
 * expirar. É uma busca por chave primária, irrelevante perto das queries destas rotas.
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

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    if (!requiredRoles.includes(user.role as Role)) {
      throw new ForbiddenException(
        'Você não tem permissão para acessar este recurso',
      );
    }

    // deixa o perfil disponível para os controllers sem nova consulta
    request.user.role = user.role;

    return true;
  }
}

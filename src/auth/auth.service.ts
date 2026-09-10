import {
  Injectable,
  Logger,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { LoginFailureReason } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { UserService } from 'src/user/user.service';
import { ADMIN_AREA_ROLES } from './roles';

/** De onde veio a tentativa. O controller extrai da requisição. */
export type ContextoDeLogin = {
  ip?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UserService,
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async validateUserGuardRouter(user: any, test: string): Promise<any> {
    const userConsult = await this.usersService.findOne(user.userId);
    if (!userConsult) {
      throw new NotFoundException('Usuário não encontrado');
    }
    // o financeiro também entra no painel, mas com abas restritas no front
    if (test === 'admin' && !ADMIN_AREA_ROLES.includes(userConsult.role)) {
      throw new UnauthorizedException('Usuário não é administrador');
    }
    return {
      id: userConsult.id,
      role: userConsult.role,
      // o painel usa os vínculos para saber em quais igrejas a pessoa trabalha
      churchRoles: userConsult.churchRoles,
      fullName: userConsult.fullName,
      email: userConsult.email,
      cpf: userConsult.cpf,
      badgeName: userConsult.badgeName,
      profilePhotoUrl: userConsult.profilePhotoUrl,
    };
  }

  async validateUser(
    document: string,
    password: string,
    contexto?: ContextoDeLogin,
  ): Promise<any> {
    const user = await this.usersService.findByDocument(document);

    if (!user) {
      await this.registrarTentativa({
        document,
        success: false,
        reason: LoginFailureReason.USER_NOT_FOUND,
        contexto,
      });

      throw new NotFoundException('Usuário não encontrado');
    }

    if (await bcrypt.compare(password, user.password)) {
      await this.registrarTentativa({
        document,
        userId: user.id,
        success: true,
        contexto,
      });

      // Remove a senha antes de retornar
      const { password: _, ...userWithoutPassword } = user;
      return userWithoutPassword;
    }

    await this.registrarTentativa({
      document,
      userId: user.id,
      success: false,
      reason: LoginFailureReason.WRONG_PASSWORD,
      contexto,
    });

    throw new UnauthorizedException('Credenciais inválidas');
  }

  /**
   * Grava a tentativa de entrada, dando certo ou não.
   *
   * Nunca derruba o login: se a escrita falhar — tabela fora do ar, disco
   * cheio —, quem digitou a senha certa entra do mesmo jeito e o problema vira
   * um aviso no log da aplicação. Auditoria que barra a porta que deveria
   * observar troca um incômodo por uma interrupção.
   *
   * A senha não passa por aqui em nenhuma hipótese, nem em claro nem em hash.
   */
  private async registrarTentativa(dados: {
    document: string;
    userId?: string;
    success: boolean;
    reason?: LoginFailureReason;
    contexto?: ContextoDeLogin;
  }) {
    try {
      await this.prisma.loginAttempt.create({
        data: {
          document: dados.document,
          userId: dados.userId ?? null,
          success: dados.success,
          reason: dados.reason ?? null,
          ip: dados.contexto?.ip ?? null,
          // o cabeçalho é longo e vem de fora: cortado para não virar um campo
          // de texto sem teto no banco
          userAgent: dados.contexto?.userAgent?.slice(0, 255) ?? null,
        },
      });
    } catch (erro) {
      this.logger.warn(
        `Não foi possível registrar a tentativa de login: ${erro?.message}`,
      );
    }
  }

  async login(user: any) {
    const payload = {
      sub: user.id,
      username: user.fullName,
      role: user.role,
    };
    return {
      access_token: this.jwtService.sign(payload),
      user,
    };
  }
}

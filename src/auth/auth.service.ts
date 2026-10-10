import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ChurchStatus, LoginFailureReason, LoginMethod } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { UserService } from 'src/user/user.service';
import { ADMIN_AREA_ROLES } from './roles';
import { perfilEfetivo } from './tenant';
import {
  captchaValido,
  FALHAS_PARA_BLOQUEIO,
  FALHAS_PARA_CAPTCHA,
  JANELA_MS,
  situacaoDoLogin,
} from './protecao-de-login';

/** De onde veio a tentativa. O controller extrai da requisição. */
export type ContextoDeLogin = {
  ip?: string | null;
  userAgent?: string | null;
  /** token do captcha (Cloudflare Turnstile), quando a tela precisou mostrar o desafio */
  captchaToken?: string;
};

/** "15 minutos", "1 minuto" — o tempo que falta, arredondado para cima. */
function minutosAte(data: Date): string {
  const minutos = Math.max(1, Math.ceil((data.getTime() - Date.now()) / 60000));
  return `${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`;
}

function loginBloqueado(ate: Date, mensagem: string) {
  return new HttpException(
    { message: mensagem, bloqueadoAte: ate.toISOString() },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

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
    // o painel usa os vínculos para saber em quais igrejas a pessoa trabalha;
    // igreja inativa não dá painel (ver `VINCULO_VALE`)
    const churchRoles = userConsult.churchRoles.filter(
      (vinculo) => vinculo.church.status !== ChurchStatus.INACTIVE,
    );
    // o perfil sai dos vínculos que valem, e não do gravado, que pode estar
    // atrasado (igreja desativada antes do recálculo existir)
    const role = perfilEfetivo({ role: userConsult.role, churchRoles });
    // o financeiro também entra no painel, mas com abas restritas no front
    if (test === 'admin' && !ADMIN_AREA_ROLES.includes(role)) {
      throw new UnauthorizedException('Usuário não é administrador');
    }
    return {
      id: userConsult.id,
      role,
      churchRoles,
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
    // a checagem vem antes de tudo: bloqueado nem chega a conferir a senha
    const situacao = await this.situacao(document);

    if (situacao.bloqueadoAte) {
      throw loginBloqueado(
        situacao.bloqueadoAte,
        `Muitas tentativas de login com senha errada. Tente novamente em ${minutosAte(
          situacao.bloqueadoAte,
        )}.`,
      );
    }

    if (
      situacao.exigeCaptcha &&
      !(await captchaValido(contexto?.captchaToken, contexto?.ip))
    ) {
      throw new UnauthorizedException({
        message: 'Confirme que você não é um robô para continuar.',
        captchaRequired: true,
      });
    }

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

      // Remove a senha antes de retornar. O perfil é o efetivo, e não o
      // gravado: é por ele que o front decide abrir o painel, e o gravado pode
      // estar atrasado em relação aos vínculos (igreja desativada)
      const { password: _, ...userWithoutPassword } = user;
      return { ...userWithoutPassword, role: perfilEfetivo(user) };
    }

    await this.registrarTentativa({
      document,
      userId: user.id,
      success: false,
      reason: LoginFailureReason.WRONG_PASSWORD,
      contexto,
    });

    // a falha de agora conta: é ela que pode pedir o captcha ou bloquear
    const falhas = situacao.falhas + 1;

    if (falhas >= FALHAS_PARA_BLOQUEIO) {
      throw loginBloqueado(
        new Date(Date.now() + JANELA_MS),
        `Você errou a senha ${falhas} vezes. Por segurança, o login foi bloqueado por ${
          JANELA_MS / 60000
        } minutos.`,
      );
    }

    throw new UnauthorizedException({
      message: 'Credenciais inválidas',
      captchaRequired: falhas >= FALHAS_PARA_CAPTCHA,
    });
  }

  /**
   * Senhas erradas deste documento desde o último acerto, nas duas últimas
   * janelas — ver `protecao-de-login.ts`.
   */
  private async situacao(document: string) {
    const desde = new Date(Date.now() - 2 * JANELA_MS);

    const ultimoAcerto = await this.prisma.loginAttempt.findFirst({
      where: { document, success: true, createdAt: { gte: desde } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const falhas = await this.prisma.loginAttempt.findMany({
      where: {
        document,
        reason: LoginFailureReason.WRONG_PASSWORD,
        createdAt: { gt: ultimoAcerto?.createdAt ?? desde },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const datas = falhas.map((falha) => falha.createdAt);
    const agora = new Date();

    return {
      ...situacaoDoLogin(datas, agora),
      // falhas que ainda contam para a próxima decisão: as da janela atual
      falhas: datas.filter((d) => d.getTime() > agora.getTime() - JANELA_MS)
        .length,
    };
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
   *
   * Pública porque o login com Google (`GoogleService`) grava na mesma tabela.
   */
  async registrarTentativa(dados: {
    document: string;
    userId?: string;
    success: boolean;
    reason?: LoginFailureReason;
    method?: LoginMethod;
    contexto?: ContextoDeLogin;
  }) {
    try {
      await this.prisma.loginAttempt.create({
        data: {
          document: dados.document,
          userId: dados.userId ?? null,
          success: dados.success,
          reason: dados.reason ?? null,
          method: dados.method ?? LoginMethod.PASSWORD,
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

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  IdentityProvider,
  LoginFailureReason,
  LoginMethod,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UserService } from 'src/user/user.service';
import { MailService } from 'src/mail/mail.service';
import { LOGO_DO_EMAIL } from 'src/mail/logo';
import { escapeHtml } from 'src/quadrante/quadrante-pdf';
import { AuthService, ContextoDeLogin } from './auth.service';
import { ContaGoogle, conferirTokenDoGoogle } from './google';
import { perfilEfetivo } from './tenant';
import { conferirSenhaAtual } from './senha';

const SEM_CADASTRO =
  'Nenhum cadastro está vinculado a esta conta Google. Entre com CPF e senha e vincule o Google em Meu perfil › Segurança.';

/** O que a tela de perfil mostra de cada conta vinculada */
const CAMPOS_DA_CONTA = {
  provider: true,
  email: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

/**
 * Login com Google e as contas vinculadas do perfil.
 *
 * O Google só confirma quem é a pessoa; quem emite a sessão continua sendo a
 * API, com o mesmo JWT e o mesmo perfil efetivo do login por CPF e senha.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);

  constructor(
    private prisma: PrismaService,
    private usersService: UserService,
    private authService: AuthService,
    private mailService: MailService,
  ) {}

  async entrar(credential: string, contexto?: ContextoDeLogin) {
    const conta = await conferirTokenDoGoogle(credential);

    const vinculo =
      (await this.prisma.userIdentity.findUnique({
        where: {
          provider_subject: {
            provider: IdentityProvider.GOOGLE,
            subject: conta.sub,
          },
        },
        select: { id: true, user: { select: { cpf: true } } },
      })) ?? (await this.vincularPeloEmail(conta, contexto));

    // a conta Google segue com o e-mail de agora, para o perfil mostrar certo
    await this.prisma.userIdentity.update({
      where: { id: vinculo.id },
      data: { email: conta.email, lastUsedAt: new Date() },
    });

    const user = await this.usersService.findByDocument(vinculo.user.cpf);

    await this.authService.registrarTentativa({
      document: conta.email,
      userId: user.id,
      success: true,
      method: LoginMethod.GOOGLE,
      contexto,
    });

    // o mesmo formato do login por senha: sem o hash e com o perfil efetivo
    const { password: _hash, ...semSenha } = user;
    return this.authService.login({ ...semSenha, role: perfilEfetivo(user) });
  }

  /**
   * Primeira entrada com esta conta Google: acha o cadastro pelo e-mail e
   * vincula na hora — só quando o Google responde pelo e-mail (ver
   * `googleEhAutoridade`). Fora disso, quem quiser usar o Google vincula pelo
   * perfil, já logado e com a senha.
   */
  private async vincularPeloEmail(
    conta: ContaGoogle,
    contexto?: ContextoDeLogin,
  ) {
    const recusar = async (mensagem: string, userId?: string) => {
      await this.authService.registrarTentativa({
        document: conta.email,
        userId,
        success: false,
        reason: LoginFailureReason.USER_NOT_FOUND,
        method: LoginMethod.GOOGLE,
        contexto,
      });
      return new NotFoundException(mensagem);
    };

    if (!conta.emailVerificado || !conta.googleEhAutoridade) {
      throw await recusar(SEM_CADASTRO);
    }

    const user = await this.prisma.user.findUnique({
      where: { email: conta.email },
      select: {
        id: true,
        cpf: true,
        email: true,
        fullName: true,
        identities: { where: { provider: IdentityProvider.GOOGLE } },
      },
    });

    if (!user) throw await recusar(SEM_CADASTRO);

    // o cadastro já tem outra conta Google: trocar é pelo perfil, com a senha
    if (user.identities.length) {
      throw await recusar(
        'Este cadastro já está vinculado a outra conta Google. Entre com ela, ou com CPF e senha.',
        user.id,
      );
    }

    const vinculo = await this.criarVinculo(user.id, conta);
    await this.avisar(user, conta.email, 'vinculada');

    return { id: vinculo.id, user: { cpf: user.cpf } };
  }

  async listar(userId: string) {
    return this.prisma.userIdentity.findMany({
      where: { userId },
      select: CAMPOS_DA_CONTA,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Vincula pelo perfil. Pede a senha atual como a troca de e-mail: quem pega
   * uma sessão aberta não pode, só com ela, plantar a própria conta Google
   * como porta de entrada permanente.
   */
  async vincular(userId: string, credential: string, senhaAtual?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { password: true, email: true, fullName: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    await conferirSenhaAtual(userId, senhaAtual, user.password);

    const conta = await conferirTokenDoGoogle(credential);
    if (!conta.emailVerificado) {
      throw new BadRequestException(
        'Confirme o e-mail da sua conta Google antes de vinculá-la.',
      );
    }

    const [daConta, doCadastro] = await Promise.all([
      this.prisma.userIdentity.findUnique({
        where: {
          provider_subject: {
            provider: IdentityProvider.GOOGLE,
            subject: conta.sub,
          },
        },
        select: { userId: true },
      }),
      this.prisma.userIdentity.findUnique({
        where: {
          userId_provider: { userId, provider: IdentityProvider.GOOGLE },
        },
        select: { id: true },
      }),
    ]);

    if (daConta) {
      throw new ConflictException(
        daConta.userId === userId
          ? 'Esta conta Google já está vinculada ao seu cadastro.'
          : 'Esta conta Google já está vinculada a outro cadastro.',
      );
    }
    if (doCadastro) {
      throw new ConflictException(
        'Seu cadastro já tem uma conta Google vinculada. Desvincule a atual antes de vincular outra.',
      );
    }

    const vinculo = await this.criarVinculo(userId, conta);
    await this.avisar(user, conta.email, 'vinculada');

    const { provider, email, createdAt, lastUsedAt } = vinculo;
    return { provider, email, createdAt, lastUsedAt };
  }

  /** Desvincular só tira uma porta: não pede senha */
  async desvincular(userId: string) {
    const vinculo = await this.prisma.userIdentity.findUnique({
      where: {
        userId_provider: { userId, provider: IdentityProvider.GOOGLE },
      },
      select: {
        id: true,
        email: true,
        user: { select: { email: true, fullName: true } },
      },
    });
    if (!vinculo) {
      throw new NotFoundException('Nenhuma conta Google vinculada.');
    }

    await this.prisma.userIdentity.delete({ where: { id: vinculo.id } });
    await this.avisar(vinculo.user, vinculo.email, 'desvinculada');

    return { message: 'Conta Google desvinculada.' };
  }

  /**
   * O índice único (`provider` + `subject`, `userId` + `provider`) é a trava
   * final: dois pedidos ao mesmo tempo não vinculam a mesma conta duas vezes.
   */
  private async criarVinculo(userId: string, conta: ContaGoogle) {
    try {
      return await this.prisma.userIdentity.create({
        data: {
          userId,
          provider: IdentityProvider.GOOGLE,
          subject: conta.sub,
          email: conta.email,
          lastUsedAt: new Date(),
        },
      });
    } catch (erro) {
      if ((erro as { code?: string })?.code === 'P2002') {
        throw new ConflictException(
          'Esta conta Google acabou de ser vinculada. Tente entrar de novo.',
        );
      }
      throw erro;
    }
  }

  /**
   * Toda porta nova (ou fechada) na conta vira e-mail para o dono, como a
   * troca de senha. Falha de e-mail não desfaz o vínculo: fica no log.
   */
  private async avisar(
    pessoa: { email: string; fullName: string },
    emailDoGoogle: string,
    acao: 'vinculada' | 'desvinculada',
  ) {
    try {
      const html = this.mailService.loadTemplate('google-account', {
        titulo: `Conta Google ${acao}`,
        userName: escapeHtml(pessoa.fullName),
        contaGoogle: escapeHtml(emailDoGoogle),
        mensagem:
          acao === 'vinculada'
            ? 'foi vinculada ao seu cadastro. A partir de agora ela também entra no sistema, pelo botão “Entrar com Google”.'
            : 'foi desvinculada do seu cadastro e não entra mais no sistema. O acesso por CPF e senha continua igual.',
      });

      await this.mailService.sendMail({
        to: pessoa.email,
        subject:
          acao === 'vinculada'
            ? 'Conta Google vinculada ao seu cadastro'
            : 'Conta Google desvinculada do seu cadastro',
        html,
        attachments: LOGO_DO_EMAIL,
      });
    } catch (erro) {
      this.logger.error(
        `Aviso de conta Google ${acao} não saiu: ${(erro as Error).message}`,
      );
    }
  }
}

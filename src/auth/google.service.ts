import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
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
import { BCRYPT_ROUNDS, conferirSenhaAtual } from './senha';
import { mascararEmail } from 'src/user/acesso';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

/**
 * A mesma resposta para toda recusa do login com Google — sem cadastro, e-mail
 * de mais de um cadastro, cadastro já ligado a outro Google. Dizer o motivo
 * contaria a quem está do outro lado o que existe no sistema com aquele
 * e-mail. O motivo fica no registro de tentativas (`userId` preenchido quando
 * havia um cadastro).
 */
const RECUSA =
  'Esta conta Google não pode ser usada para entrar. Entre com CPF e senha.';

/** `UserToken.type` do código que confirma o vínculo pelo perfil */
export const TOKEN_TYPE_GOOGLE_LINK = 1;
const VALIDADE_DO_CODIGO_MS = 15 * 60_000;
const REENVIO_MS = 60_000;
const MAXIMO_DE_ERROS = 5;
const CODIGO_INVALIDO =
  'Código expirado ou inválido. Escolha a conta Google de novo para receber outro.';

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
   * `googleEhAutoridade`) e o e-mail é de um cadastro só. Fora disso, quem
   * quiser usar o Google vincula pelo perfil, já logado.
   */
  private async vincularPeloEmail(
    conta: ContaGoogle,
    contexto?: ContextoDeLogin,
  ) {
    const recusar = async (userId?: string) => {
      await this.authService.registrarTentativa({
        document: conta.email,
        userId,
        success: false,
        reason: LoginFailureReason.USER_NOT_FOUND,
        method: LoginMethod.GOOGLE,
        contexto,
      });
      return new NotFoundException(RECUSA);
    };

    if (!conta.emailVerificado || !conta.googleEhAutoridade) {
      throw await recusar();
    }

    // dois bastam para saber que é ambíguo
    const donos = await this.prisma.user.findMany({
      where: { email: conta.email },
      select: {
        id: true,
        cpf: true,
        email: true,
        fullName: true,
        identities: { where: { provider: IdentityProvider.GOOGLE } },
      },
      take: 2,
    });

    if (!donos.length) throw await recusar();

    // e-mail de mais de um cadastro (repetido antigo, ou uma família que
    // divide a caixa): não há como saber de quem é a conta Google. Não entra
    // nem vincula; cada pessoa vincula pelo perfil
    if (donos.length > 1) {
      throw await recusar();
    }

    const [user] = donos;

    // o cadastro já tem outra conta Google: trocar é pelo perfil, com a senha
    if (user.identities.length) {
      throw await recusar(user.id);
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
   * Vínculo pelo perfil, passo 1: confere a senha atual e a conta Google, e
   * manda um código para o e-mail do cadastro. Nada é vinculado ainda.
   *
   * São duas provas: a senha diz que é o dono da conta (quem pega uma sessão
   * aberta não planta a própria conta Google como porta permanente), e o
   * código diz que é o dono da caixa de entrada — que o sistema nunca tinha
   * confirmado. O código vale só para a conta Google escolhida aqui.
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

    await this.assertPodeVincular(userId, conta.sub);

    const pendente = await this.prisma.userToken.findFirst({
      where: { userId, type: TOKEN_TYPE_GOOGLE_LINK },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    // sem o intervalo, a tela vira um jeito de encher a caixa de alguém
    if (pendente && Date.now() - pendente.createdAt.getTime() < REENVIO_MS) {
      throw new HttpException(
        'Acabamos de enviar um código. Aguarde um minuto para pedir outro.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const codigo = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const codeHash = await bcrypt.hash(codigo, BCRYPT_ROUNDS);

    // interativa: a forma em array perde as escritas com o middleware de
    // auditoria (ver `PasswordResetService.requestReset`)
    await this.prisma.$transaction(async (tx) => {
      await tx.userToken.deleteMany({
        where: { userId, type: TOKEN_TYPE_GOOGLE_LINK },
      });
      await tx.userToken.create({
        data: {
          userId,
          type: TOKEN_TYPE_GOOGLE_LINK,
          codeHash,
          payload: { subject: conta.sub, email: conta.email },
          expiresAt: new Date(Date.now() + VALIDADE_DO_CODIGO_MS),
        },
      });
    });

    await this.enviar(user, {
      titulo: 'Código para vincular a conta Google',
      contaGoogle: conta.email,
      mensagem: `quer ser vinculada ao seu cadastro. Para confirmar, digite o código <strong style="font-size: 18px; letter-spacing: 2px">${codigo}</strong> em Meu perfil › Segurança. Ele vale 15 minutos.`,
      assunto: `${codigo} é o código para vincular a conta Google`,
    });

    return {
      message: 'Enviamos um código de 8 dígitos para o e-mail do cadastro.',
      email: mascararEmail(user.email),
    };
  }

  /**
   * Vínculo pelo perfil, passo 2: o código do e-mail confere e a conta Google
   * escolhida no passo 1 é vinculada. Cinco erros destroem o código.
   */
  async confirmarVinculo(userId: string, codigo: string) {
    const token = await this.prisma.userToken.findFirst({
      where: { userId, type: TOKEN_TYPE_GOOGLE_LINK },
      orderBy: { createdAt: 'desc' },
    });

    const descartar = () =>
      this.prisma.userToken.deleteMany({
        where: { userId, type: TOKEN_TYPE_GOOGLE_LINK },
      });

    if (!token) throw new BadRequestException(CODIGO_INVALIDO);

    if (token.expiresAt <= new Date() || token.attempts >= MAXIMO_DE_ERROS) {
      await descartar();
      throw new BadRequestException(CODIGO_INVALIDO);
    }

    if (!(await bcrypt.compare(codigo, token.codeHash))) {
      const attempts = token.attempts + 1;
      if (attempts >= MAXIMO_DE_ERROS) await descartar();
      else
        await this.prisma.userToken.update({
          where: { id: token.id },
          data: { attempts },
        });
      throw new BadRequestException('Código incorreto.');
    }

    const { subject, email } = token.payload as {
      subject: string;
      email: string;
    };

    // entre o passo 1 e este a conta Google pode ter sido vinculada a outro
    await this.assertPodeVincular(userId, subject);

    const vinculo = await this.criarVinculo(userId, { sub: subject, email });
    await descartar();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    if (user) await this.avisar(user, email, 'vinculada');

    const { provider, createdAt, lastUsedAt } = vinculo;
    return { provider, email, createdAt, lastUsedAt };
  }

  /** A conta Google é livre e o cadastro ainda não tem Google */
  private async assertPodeVincular(userId: string, subject: string) {
    const [daConta, doCadastro] = await Promise.all([
      this.prisma.userIdentity.findUnique({
        where: {
          provider_subject: { provider: IdentityProvider.GOOGLE, subject },
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
  private async criarVinculo(
    userId: string,
    conta: Pick<ContaGoogle, 'sub' | 'email'>,
  ) {
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
    await this.enviar(pessoa, {
      titulo: `Conta Google ${acao}`,
      contaGoogle: emailDoGoogle,
      mensagem:
        acao === 'vinculada'
          ? 'foi vinculada ao seu cadastro. A partir de agora ela também entra no sistema, pelo botão “Entrar com Google”.'
          : 'foi desvinculada do seu cadastro e não entra mais no sistema. O acesso por CPF e senha continua igual.',
      assunto:
        acao === 'vinculada'
          ? 'Conta Google vinculada ao seu cadastro'
          : 'Conta Google desvinculada do seu cadastro',
    });
  }

  /**
   * Template `google-account`, para o e-mail do cadastro. Falha de e-mail não
   * desfaz nada: fica no log. `mensagem` entra como HTML — só texto fixo daqui.
   */
  private async enviar(
    pessoa: { email: string; fullName: string },
    dados: {
      titulo: string;
      contaGoogle: string;
      mensagem: string;
      assunto: string;
    },
  ) {
    try {
      const html = this.mailService.loadTemplate('google-account', {
        titulo: dados.titulo,
        userName: escapeHtml(pessoa.fullName),
        contaGoogle: escapeHtml(dados.contaGoogle),
        mensagem: dados.mensagem,
      });

      await this.mailService.sendMail({
        to: pessoa.email,
        subject: dados.assunto,
        html,
        attachments: LOGO_DO_EMAIL,
      });
    } catch (erro) {
      this.logger.error(
        `E-mail "${dados.titulo}" não saiu: ${(erro as Error).message}`,
      );
    }
  }
}

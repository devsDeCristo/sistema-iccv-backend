import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomInt } from 'crypto';
import * as path from 'path';
import { PrismaService } from 'src/prisma';
import { MailService } from 'src/mail/mail.service';

/**
 * Tipos de `UserToken`. Redefinição de senha é o 0; um fluxo novo entra como 1
 * sem mexer no banco.
 */
export const TOKEN_TYPE_PASSWORD_RESET = 0;

/** Validade do código de 8 dígitos que vai no e-mail. */
const CODE_TTL_MINUTES = 60;
/** Validade do ticket entregue depois que o código confere. */
const TICKET_TTL_MINUTES = 15;
/** Erros de código tolerados antes de o token ser destruído. */
const MAX_CODE_ATTEMPTS = 5;
/** Intervalo mínimo entre dois envios para o mesmo CPF. */
const RESEND_COOLDOWN_SECONDS = 60;
const BCRYPT_ROUNDS = 10;

/**
 * Uma única resposta para "CPF existe", "CPF não existe" e "acabei de mandar um
 * código, espera o cooldown". Qualquer diferença entre esses casos transforma a
 * tela de recuperação em consulta de quem é cadastrado na igreja.
 */
const GENERIC_REQUEST_MESSAGE =
  'Se o CPF estiver cadastrado, enviamos um código de 8 dígitos para o e-mail do cadastro.';
const INVALID_CODE_MESSAGE =
  'Código inválido ou expirado. Solicite um novo código.';
/**
 * Ticket inválido responde 401, e não 400: o 400 desta rota é erro de
 * preenchimento (senha curta demais, por exemplo) e o usuário corrige na
 * mesma tela, enquanto o 401 diz que a credencial morreu e o front tem que
 * recomeçar pelo CPF.
 */
const INVALID_TICKET_MESSAGE =
  'Sessão de redefinição expirada. Comece o processo de novo.';

/** Vai para dentro do HTML do e-mail — precisa ser escapado. */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000);

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Etapa 1 — o usuário informa o CPF e recebe um código por e-mail.
   *
   * Devolve sempre a mesma mensagem, com ou sem cadastro: quem está do outro
   * lado não descobre se o CPF existe.
   */
  async requestReset(document: string) {
    const user = await this.prisma.user.findUnique({
      where: { cpf: document },
      select: { id: true, email: true, fullName: true },
    });

    if (!user?.email) {
      return { message: GENERIC_REQUEST_MESSAGE };
    }

    const active = await this.prisma.userToken.findFirst({
      where: { userId: user.id, type: TOKEN_TYPE_PASSWORD_RESET },
      orderBy: { createdAt: 'desc' },
    });

    // Sem o cooldown, um script transforma a caixa de entrada de qualquer
    // cadastrado em depósito de e-mail nosso.
    const cooldownAtivo =
      active &&
      Date.now() - active.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1_000;

    if (cooldownAtivo) {
      return { message: GENERIC_REQUEST_MESSAGE };
    }

    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);

    // Um pedido novo invalida o anterior: só existe um código válido por vez.
    //
    // Transação interativa, e não a forma em array `$transaction([a, b])`: o
    // middleware de auditoria do PrismaService (`$use`) dispara consultas
    // próprias no client raiz, e isso desfaz o batch em silêncio — as escritas
    // somem, sem erro nenhum. Aqui o código ia parar no e-mail com um token que
    // não existia mais no banco.
    await this.prisma.$transaction(async (tx) => {
      await tx.userToken.deleteMany({
        where: { userId: user.id, type: TOKEN_TYPE_PASSWORD_RESET },
      });

      await tx.userToken.create({
        data: {
          userId: user.id,
          type: TOKEN_TYPE_PASSWORD_RESET,
          codeHash,
          expiresAt: minutesFromNow(CODE_TTL_MINUTES),
        },
      });
    });

    await this.sendCodeEmail(user.email, user.fullName, code);

    return { message: GENERIC_REQUEST_MESSAGE };
  }

  /**
   * Etapa 2 — o código confere e vira um ticket de uso único.
   *
   * A troca existe para o código de 8 dígitos não ficar circulando junto com a
   * senha nova: da tela de senha em diante o que vale é o ticket, que tem 256
   * bits, vida de 15 minutos e morre no primeiro uso.
   */
  async verifyCode(document: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { cpf: document },
      select: { id: true },
    });

    if (!user) {
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    const token = await this.prisma.userToken.findFirst({
      where: { userId: user.id, type: TOKEN_TYPE_PASSWORD_RESET },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    if (token.expiresAt <= new Date() || token.attempts >= MAX_CODE_ATTEMPTS) {
      await this.discard(token.id);
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    if (!(await bcrypt.compare(code, token.codeHash))) {
      const attempts = token.attempts + 1;

      // Chegou no teto: o token some e o usuário recomeça pelo CPF. É o que
      // impede varrer as 10^8 combinações do código.
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await this.discard(token.id);
      } else {
        await this.prisma.userToken.update({
          where: { id: token.id },
          data: { attempts },
        });
      }

      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    const ticket = randomBytes(32).toString('hex');

    await this.prisma.userToken.update({
      where: { id: token.id },
      data: {
        ticketHash: sha256(ticket),
        attempts: 0,
        // A partir daqui a janela é a do ticket, mais curta que a do código.
        expiresAt: minutesFromNow(TICKET_TTL_MINUTES),
      },
    });

    return { ticket, expiresInMinutes: TICKET_TTL_MINUTES };
  }

  /**
   * Etapa 3 — grava a senha nova e encerra o processo.
   *
   * O token é apagado na mesma transação da senha: ticket usado não volta.
   */
  async resetPassword(ticket: string, password: string) {
    const token = await this.prisma.userToken.findFirst({
      where: { ticketHash: sha256(ticket), type: TOKEN_TYPE_PASSWORD_RESET },
      include: { user: { select: { email: true, fullName: true } } },
    });

    if (!token) {
      throw new UnauthorizedException(INVALID_TICKET_MESSAGE);
    }

    if (token.expiresAt <= new Date()) {
      await this.discard(token.id);
      throw new UnauthorizedException(INVALID_TICKET_MESSAGE);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Interativa pelo mesmo motivo do `requestReset`: com a forma em array o
    // middleware de auditoria descarta as escritas sem lançar erro — aqui isso
    // significaria senha não gravada e ticket continuando de pé.
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: token.userId },
        data: { password: passwordHash },
      });

      await tx.userToken.deleteMany({
        where: { userId: token.userId, type: TOKEN_TYPE_PASSWORD_RESET },
      });
    });

    // Aviso de senha alterada: se não foi o dono quem trocou, é por este e-mail
    // que ele descobre.
    await this.sendChangedEmail(token.user.email, token.user.fullName);

    return {
      message: 'Senha redefinida com sucesso. Entre com a nova senha.',
    };
  }

  private async discard(id: string) {
    await this.prisma.userToken.delete({ where: { id } }).catch(() => {
      // Corrida com outra requisição que já apagou a linha: não há o que fazer.
    });
  }

  /**
   * O logo vai anexado com `cid`, como nos outros e-mails. Aqui é a versão
   * branca: o cabeçalho destes dois e-mails é a faixa índigo da marca, e o
   * `logo.png` original é preto — sumiria dentro dela.
   */
  private get logoAttachment() {
    return [
      {
        filename: 'logo.png',
        path: path.join(
          process.cwd(),
          'src',
          'mail',
          'templates',
          'assets',
          'logo-branca.png',
        ),
        cid: 'logo',
      },
    ];
  }

  private async sendCodeEmail(email: string, fullName: string, code: string) {
    const html = this.mailService.loadTemplate('password-reset-code', {
      userName: escapeHtml(fullName),
      code,
      expiraEm: `${CODE_TTL_MINUTES} minutos`,
    });

    await this.trySend(email, 'Código para redefinir sua senha', html);
  }

  private async sendChangedEmail(email: string, fullName: string) {
    const html = this.mailService.loadTemplate('password-changed', {
      userName: escapeHtml(fullName),
    });

    await this.trySend(email, 'Sua senha foi alterada', html);
  }

  /**
   * Falha de e-mail não pode virar resposta diferente para o front: a mensagem
   * genérica é a mesma, e o problema fica no log.
   */
  private async trySend(to: string, subject: string, html: string) {
    try {
      await this.mailService.sendMail({
        to,
        subject,
        html,
        attachments: this.logoAttachment,
      });
    } catch (error) {
      this.logger.error(`Falha ao enviar "${subject}"`, error);
    }
  }
}

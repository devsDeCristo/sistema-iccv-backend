import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { normalizarEmail } from 'src/user/acesso';

/** O que o sistema usa de uma conta Google confirmada */
export type ContaGoogle = {
  /** id da pessoa no Google: não muda quando o e-mail muda */
  sub: string;
  email: string;
  /** o nome na conta Google, para adiantar o cadastro de quem ainda não tem */
  nome: string | null;
  emailVerificado: boolean;
  /**
   * O Google responde pela caixa de entrada: Gmail ou domínio do Workspace
   * (`hd`). Só aí `email_verified` prova que quem entrou é o dono do e-mail
   * hoje — num e-mail de fora (um Outlook usado como conta Google) ele diz
   * só que o endereço foi confirmado um dia, e o endereço pode ter mudado de
   * dono depois.
   */
  googleEhAutoridade: boolean;
};

const cliente = new OAuth2Client();

/**
 * Confere o ID token que o botão do Google entregou ao front: assinatura
 * (chaves públicas do Google), emissor, validade e — o que impede usar aqui um
 * token emitido para outro site — se ele foi emitido para o nosso Client ID.
 *
 * Erra com 400, e não 401: no front, 401 numa rota logada é sessão vencida e
 * derruba o login.
 */
export async function conferirTokenDoGoogle(
  credential: string,
): Promise<ContaGoogle> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new ServiceUnavailableException(
      'O login com Google não está habilitado.',
    );
  }

  let payload: TokenPayload | undefined;
  try {
    const ticket = await cliente.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    payload = ticket.getPayload();
  } catch {
    payload = undefined;
  }

  if (!payload?.sub || !payload.email) {
    throw new BadRequestException(
      'Não foi possível confirmar a sua conta Google. Tente de novo.',
    );
  }

  const email = normalizarEmail(payload.email);

  return {
    sub: payload.sub,
    email,
    nome: payload.name?.trim() || null,
    emailVerificado: payload.email_verified === true,
    googleEhAutoridade: email.endsWith('@gmail.com') || !!payload.hd,
  };
}

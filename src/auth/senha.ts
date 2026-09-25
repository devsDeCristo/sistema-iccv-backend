import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

/** O mesmo custo para toda senha e todo código guardado com bcrypt */
export const BCRYPT_ROUNDS = 10;

/**
 * Tamanho aceito, igual no cadastro e na redefinição. O NIST (SP 800-63B)
 * recomenda exigir tamanho e não composição obrigatória de maiúscula/símbolo —
 * regra de composição empurra para senhas previsíveis do tipo "Senha1!". O teto
 * de 72 é o limite do bcrypt: o que passa disso é ignorado no hash sem aviso.
 */
export const SENHA_MINIMA = 8;
export const SENHA_MAXIMA = 72;

export function hashDaSenha(senha: string): Promise<string> {
  return bcrypt.hash(senha, BCRYPT_ROUNDS);
}

/** Erros de senha atual tolerados antes de travar a conferência */
const ERROS_TOLERADOS = 5;
const TRAVA_MS = 15 * 60_000;

// ponytail: contagem em memória, por processo — zera num restart e não é
// compartilhada entre réplicas. Vai para o banco (ou Redis) se a API passar a
// rodar com mais de uma instância.
const errosDeSenhaAtual = new Map<
  string,
  { quantos: number; travadoAte?: number }
>();

/**
 * Confere a senha atual de quem já está logado, antes de uma ação sensível
 * (trocar a senha, trocar o e-mail).
 *
 * A sessão sozinha não basta: quem pega um navegador aberto não pode, só com
 * ele, trocar a senha ou o e-mail de recuperação e tomar a conta. Cinco erros
 * travam a conferência por 15 minutos, contra tentativa e erro.
 *
 * Erra com 400, e não 401: no front, 401 é sessão vencida e derruba o login.
 */
export async function conferirSenhaAtual(
  userId: string,
  senha: string | undefined,
  hash: string,
): Promise<void> {
  const agora = Date.now();
  const registro = errosDeSenhaAtual.get(userId);

  if (registro?.travadoAte && registro.travadoAte > agora) {
    throw new HttpException(
      'Muitas tentativas com a senha atual errada. Tente de novo em alguns minutos.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  if (senha && (await bcrypt.compare(senha, hash))) {
    errosDeSenhaAtual.delete(userId);
    return;
  }

  // a trava vencida recomeça a contagem
  const anteriores = registro?.travadoAte ? 0 : registro?.quantos ?? 0;
  const quantos = anteriores + 1;
  errosDeSenhaAtual.set(userId, {
    quantos,
    travadoAte: quantos >= ERROS_TOLERADOS ? agora + TRAVA_MS : undefined,
  });

  throw new BadRequestException('Senha atual incorreta');
}

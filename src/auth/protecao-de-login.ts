/**
 * Freio contra senha errada repetida, por documento.
 *
 * Conta só senha errada (`WRONG_PASSWORD`) desde o último acerto. Documento
 * inexistente fica de fora: ele leva a pessoa para o cadastro, e quem digitou
 * o CPF errado não está tentando adivinhar senha de ninguém.
 */
export const FALHAS_PARA_CAPTCHA = 2;
export const FALHAS_PARA_BLOQUEIO = 5;
/** Janela em que as falhas se somam, e também a duração do bloqueio. */
export const JANELA_MS = 15 * 60 * 1000;

export type SituacaoDoLogin = {
  bloqueadoAte: Date | null;
  exigeCaptcha: boolean;
};

/**
 * @param falhas datas das senhas erradas desde o último acerto, da mais nova
 * para a mais antiga, das últimas duas janelas (a de contagem mais a do
 * bloqueio).
 *
 * O bloqueio é medido a partir da última falha, e não de agora: durante o
 * bloqueio nenhuma tentativa é gravada, então a última falha é a que bloqueou,
 * e as falhas antigas saindo da janela não soltam o bloqueio antes da hora.
 */
export function situacaoDoLogin(
  falhas: Date[],
  agora = new Date(),
): SituacaoDoLogin {
  const ultima = falhas[0];

  if (ultima) {
    const fimDoBloqueio = new Date(ultima.getTime() + JANELA_MS);
    const junto = falhas.filter(
      (falha) => falha.getTime() > ultima.getTime() - JANELA_MS,
    ).length;

    if (junto >= FALHAS_PARA_BLOQUEIO && agora < fimDoBloqueio) {
      return { bloqueadoAte: fimDoBloqueio, exigeCaptcha: true };
    }
  }

  const recentes = falhas.filter(
    (falha) => falha.getTime() > agora.getTime() - JANELA_MS,
  ).length;

  return {
    bloqueadoAte: null,
    exigeCaptcha: recentes >= FALHAS_PARA_CAPTCHA,
  };
}

/**
 * Confere o token do Cloudflare Turnstile.
 *
 * Turnstile e não reCAPTCHA: o gratuito do Google caiu para 10 mil
 * verificações por mês em 2026; o Turnstile não tem esse teto.
 *
 * Sem `TURNSTILE_SECRET_KEY` o captcha fica desligado (ambiente local sem
 * chave): o bloqueio por tentativas continua valendo. Cloudflare fora do ar
 * conta como captcha inválido — é o lado seguro do erro.
 */
export async function captchaValido(
  token: string | undefined,
  ip?: string | null,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  try {
    const resposta = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        body: new URLSearchParams({
          secret,
          response: token,
          ...(ip ? { remoteip: ip } : {}),
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    const corpo = (await resposta.json()) as { success?: boolean };
    return corpo.success === true;
  } catch {
    return false;
  }
}

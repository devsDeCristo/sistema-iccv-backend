/**
 * Saúde e religião no cadastro são dados sensíveis (LGPD, art. 11), e a base
 * para tratá-los aqui é o consentimento específico e destacado do titular — o
 * aceite dos Termos de Uso não basta. Sem esse consentimento, nada sensível é
 * gravado; revogar apaga o que havia.
 *
 * A regra fica aqui, e não espalhada por criação, edição e aceite: são três
 * caminhos que gravam esses campos, e a mesma resposta tem que valer nos três.
 */

export const CAMPOS_SENSIVEIS = [
  'religion',
  'diabetes',
  'hypertensive',
] as const;

type CampoSensivel = (typeof CAMPOS_SENSIVEIS)[number];

export interface DadosSensiveis {
  religion?: string | null;
  diabetes?: boolean | null;
  hypertensive?: boolean | null;
}

/** Tira os campos sensíveis de um corpo, para que só a regra decida sobre eles */
export function separarSensiveis<T extends Record<string, unknown>>(
  dados: T,
): [DadosSensiveis, Omit<T, CampoSensivel>] {
  const sensiveis: Record<string, unknown> = {};
  const resto: Record<string, unknown> = { ...dados };

  for (const campo of CAMPOS_SENSIVEIS) {
    if (campo in resto) {
      sensiveis[campo] = resto[campo];
      delete resto[campo];
    }
  }

  return [sensiveis as DadosSensiveis, resto as Omit<T, CampoSensivel>];
}

/**
 * O que gravar dos dados sensíveis, dado o consentimento.
 *
 * - `pedido === true`: grava o que veio e registra o consentimento — mantendo
 *   a data original, se ele já existia.
 * - `pedido === false`: revogação. Os três campos e o consentimento são
 *   apagados.
 * - `pedido === undefined`: o consentimento não foi mexido. Se ele já existia,
 *   grava o que veio; se não, os campos sensíveis são descartados.
 *
 * Devolve só o pedaço a mesclar no `data` do Prisma.
 */
export function aplicarConsentimento(
  sensiveis: DadosSensiveis,
  pedido: boolean | undefined,
  consentidoEm: Date | null,
  agora = new Date(),
): DadosSensiveis & { sensitiveConsentAt?: Date | null } {
  if (pedido === false) {
    return {
      religion: null,
      diabetes: null,
      hypertensive: null,
      sensitiveConsentAt: null,
    };
  }

  // texto vazio em religião é "não informado", não uma religião
  const recebidos = {
    ...sensiveis,
    ...('religion' in sensiveis
      ? { religion: sensiveis.religion || null }
      : {}),
  };

  if (pedido === true) {
    return { ...recebidos, sensitiveConsentAt: consentidoEm ?? agora };
  }

  return consentidoEm ? recebidos : {};
}

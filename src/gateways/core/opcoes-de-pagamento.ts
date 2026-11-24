import { PaymentMethod } from '@prisma/client';
import { CredentialField } from './gateway.types';

/**
 * O que a igreja escolhe oferecer no checkout: formas de pagamento e teto de
 * parcelas. Mora no cofre como os outros campos não-secretos (a URL da API, as
 * parcelas do Ton), e a tela desenha a etapa de pagamento a
 * partir destes dois tipos de campo.
 */

export const CAMPO_DE_FORMAS = 'enabledMethods';
export const CAMPO_DE_PARCELAS = 'maxInstallments';

export const campoDeFormas = (
  formas: readonly PaymentMethod[],
  extras: Partial<CredentialField> = {},
): CredentialField => ({
  key: CAMPO_DE_FORMAS,
  label: 'Formas de pagamento',
  required: false,
  secret: false,
  methods: [...formas],
  help: 'As que o inscrito pode escolher no checkout.',
  ...extras,
});

export const campoDeParcelas = (
  teto: number,
  help = 'Número máximo de parcelas no cartão. Os juros seguem o que está configurado na conta do gateway.',
): CredentialField => ({
  key: CAMPO_DE_PARCELAS,
  label: 'Parcelas no cartão',
  required: false,
  secret: false,
  installmentsMax: teto,
  help,
});

/**
 * As formas escolhidas, na ordem em que o gateway as lista. Nada escolhido (o
 * campo nunca foi salvo) é o padrão — todas, salvo quando o gateway diz outra
 * coisa: integração antiga continua oferecendo o que sempre ofereceu.
 */
export function formasEscolhidas<T extends PaymentMethod>(
  valor: string | undefined,
  todas: readonly T[],
  padrao: readonly T[] = todas,
): T[] {
  const escolhidas = (valor ?? '').split(',');
  const formas = todas.filter((forma) => escolhidas.includes(forma));

  return formas.length ? formas : [...padrao];
}

/** O teto escolhido, limitado ao do gateway; ausente ou inválido é `null` (padrão do gateway) */
export function parcelasEscolhidas(
  valor: string | undefined,
  teto: number,
): number | null {
  const n = Number(valor);

  return valor && Number.isInteger(n) && n >= 1 ? Math.min(n, teto) : null;
}

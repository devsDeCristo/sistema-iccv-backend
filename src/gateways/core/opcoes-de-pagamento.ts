import { UnprocessableEntityException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { GatewayRequestError } from './gateway.errors';
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

/**
 * O Pix na tela do sistema.
 *
 * Com o Pix ligado, ele sai do checkout do gateway e passa a ser pago aqui,
 * com QR dinâmico criado pela API de pedidos do gateway; as outras formas
 * continuam no checkout. A pergunta ao inscrito é entre as duas coisas, e
 * `CREDIT_CARD` é o nome da segunda: "o checkout do gateway", com o que
 * estiver ligado lá (cartão, boleto, saldo).
 */
export const CHECKOUT_DO_GATEWAY = PaymentMethod.CREDIT_CARD;

/** O que perguntar: nada sem Pix; só o Pix quando é a única forma; senão as duas saídas */
export function escolhasComPixNaTela(formas: PaymentMethod[]): PaymentMethod[] {
  if (!formas.includes(PaymentMethod.PIX)) return [];

  return formas.some((forma) => forma !== PaymentMethod.PIX)
    ? [PaymentMethod.PIX, CHECKOUT_DO_GATEWAY]
    : [PaymentMethod.PIX];
}

/** O pedido sai em Pix: escolhido pelo inscrito, ou por ser a única forma ligada */
export function querPixNaTela(
  formas: PaymentMethod[],
  pedida?: PaymentMethod,
): boolean {
  if (!formas.includes(PaymentMethod.PIX)) return false;

  return (
    pedida === PaymentMethod.PIX ||
    formas.every((forma) => forma === PaymentMethod.PIX)
  );
}

/** As formas do checkout do gateway: o Pix ligado vai para a nossa tela, e não para lá */
export function formasDoCheckout<T extends PaymentMethod>(formas: T[]): T[] {
  return formas.filter((forma) => forma !== PaymentMethod.PIX);
}

/**
 * O nome da segunda saída da pergunta, com o que a igreja ligou: "Cartão",
 * "Boleto", "Cartão ou boleto". O gateway pode dar o seu (`methodLabels`): no
 * PayPal é "Cartão ou conta PayPal".
 */
export function rotuloDoCheckout(
  campos: CredentialField[],
  credenciais: Record<string, string>,
): string {
  const campo = (campos ?? []).find((c) => c.methods);
  const proprio = campo?.methodLabels?.[CHECKOUT_DO_GATEWAY];
  if (proprio) return proprio;

  const formas = formasEscolhidas(
    credenciais?.[CAMPO_DE_FORMAS],
    campo?.methods ?? [],
    campo?.defaultMethods,
  );
  const partes = [
    formas.some(
      (f) => f === PaymentMethod.CREDIT_CARD || f === PaymentMethod.DEBIT_CARD,
    ) && 'cartão',
    formas.includes(PaymentMethod.BOLETO) && 'boleto',
  ].filter((parte): parte is string => !!parte);

  const texto = partes.length ? partes.join(' ou ') : 'outras formas';
  return texto[0].toUpperCase() + texto.slice(1);
}

export const PIX_INDISPONIVEL =
  'O Pix não está disponível agora. Escolha outra forma de pagamento.';

/**
 * A recusa do gateway ao criar o Pix vira uma mensagem que o inscrito entende.
 *
 * O caso comum é a conta da igreja sem chave Pix: no checkout o gateway só
 * escondia o Pix, e aqui a criação falha. Melhor dizer "escolha outra forma"
 * do que mostrar "não foi possível falar com o gateway".
 */
export function pixIndisponivel(erro: unknown): unknown {
  return erro instanceof GatewayRequestError
    ? new UnprocessableEntityException(PIX_INDISPONIVEL)
    : erro;
}

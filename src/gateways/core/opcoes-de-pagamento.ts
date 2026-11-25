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

export const CAMPO_DE_REPASSE = 'serviceFees';

/**
 * Repassar a taxa do gateway ao inscrito: um percentual por forma, que a tela
 * preenche com o pior cenário conhecido (recebimento na hora) e a igreja
 * ajusta para o plano dela — a API de nenhum gateway informa a taxa da conta
 * antes do pagamento.
 */
export const campoDeRepasse = (
  formas: readonly PaymentMethod[],
): CredentialField => ({
  key: CAMPO_DE_REPASSE,
  label: 'Repassar taxas para o cliente',
  required: false,
  secret: false,
  fees: [...formas],
  help: 'O inscrito paga a taxa de serviço junto, e a igreja recebe o valor cheio. Informe a taxa do seu plano em cada forma.',
});

/** `PIX=0.99,CREDIT_CARD=4.98` → `{ PIX: 0.99, CREDIT_CARD: 4.98 }`; inválido some */
export function lerTaxas(
  valor: string | undefined,
): Partial<Record<PaymentMethod, number>> {
  const taxas: Partial<Record<PaymentMethod, number>> = {};
  for (const par of (valor ?? '').split(',')) {
    const [forma, texto] = par.split('=');
    const taxa = Number(texto);
    if (forma && texto && Number.isFinite(taxa) && taxa >= 0 && taxa < 100) {
      taxas[forma as PaymentMethod] = taxa;
    }
  }
  return taxas;
}

/**
 * A taxa de serviço, em pontos percentuais, de cada caminho do pagamento:
 *
 * - `pix`: a do Pix na nossa tela (nulo quando o Pix não é pago lá);
 * - `checkout`: a do checkout do gateway. Lá o inscrito escolhe a forma
 *   depois que o valor já foi fechado, então vale a **maior** taxa entre as
 *   formas que ficam no checkout — o pior caso, para a igreja nunca receber
 *   menos que o cheio.
 *
 * Nulo quando a igreja não repassa taxa.
 */
export function taxasDeServico(
  campos: CredentialField[],
  credenciais: Record<string, string> | undefined,
): { pix: number | null; checkout: number } | null {
  const campoRepasse = (campos ?? []).find((c) => c.fees);
  const taxas = lerTaxas(credenciais?.[CAMPO_DE_REPASSE]);
  if (!campoRepasse || !Object.keys(taxas).length) return null;

  const campoFormas = campos.find((c) => c.methods);
  // gateway sem escolha de formas (InfinitePay): todas as do repasse
  const formas = campoFormas
    ? formasEscolhidas(
        credenciais?.[CAMPO_DE_FORMAS],
        campoFormas.methods ?? [],
        campoFormas.defaultMethods,
      )
    : campoRepasse.fees ?? [];

  // Pix na tela só existe em gateway com escolha de formas: a InfinitePay
  // oferece o Pix dentro do link dela, junto do cartão
  const pixNaTela =
    !!campoFormas && escolhasComPixNaTela(formas).includes(PaymentMethod.PIX);
  const doCheckout = pixNaTela ? formasDoCheckout(formas) : formas;

  return {
    pix: pixNaTela ? taxas.PIX ?? 0 : null,
    checkout: Math.max(0, ...doCheckout.map((forma) => taxas[forma] ?? 0)),
  };
}

/**
 * Quanto cobrar para a igreja receber `liquido` depois da taxa: a conta é por
 * divisão. Com 4,98%, R$ 120,00 viram R$ 126,29 — somar 4,98% daria R$ 126,00
 * e a igreja receberia menos que R$ 120,00.
 */
export function taxaDeServicoEmCentavos(
  liquidoEmCentavos: number,
  percentual: number,
): number {
  if (!percentual || liquidoEmCentavos <= 0) return 0;
  return (
    Math.round(liquidoEmCentavos / (1 - percentual / 100)) - liquidoEmCentavos
  );
}

import { PaymentMethod } from '@prisma/client';
import {
  GatewayCharge,
  GatewayContext,
  GatewayHealth,
  GatewayWebhookEvent,
  HostedCheckoutRequest,
  HostedCheckoutResult,
  PaymentGatewayDescriptor,
  WebhookRequest,
} from './gateway.types';

/**
 * Token de injeção da lista de adapters. Ver `GatewaysModule`: é lá que a
 * lista é montada, e é o único lugar que precisa mudar para uma casa nova
 * entrar no sistema.
 */
export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');

/**
 * O que toda casa de pagamento precisa saber fazer.
 *
 * O contrato é o do **checkout hospedado**: o sistema pede um link, o inscrito
 * paga do lado de lá, e a casa avisa por webhook. É o menor denominador comum
 * entre as quatro e o que mantém o cartão fora daqui — dado de cartão que não
 * passa pelo servidor é dado que não vaza dele.
 *
 * Nenhum método recebe a igreja ou a credencial solta: tudo vem em
 * `GatewayContext`, montado pelo registry. O adapter não conhece Prisma, não
 * conhece a chave de criptografia e não decide de quem é o dinheiro.
 */
export interface PaymentGateway {
  readonly descriptor: PaymentGatewayDescriptor;

  /**
   * As formas entre as quais o inscrito escolhe **antes** de o checkout ser
   * criado. Ausente, ou com menos de duas, não há o que perguntar — que é o
   * caso de todo gateway cuja página já oferece as formas lado a lado.
   *
   * Existe por causa do PayPal: lá o Pix e a carteira/cartão são pedidos
   * diferentes, e o tipo do pedido tem que ser decidido na criação. Recebe o
   * contexto porque a resposta depende da configuração da igreja (a conta
   * precisa ter o Pix habilitado).
   */
  paymentMethodChoices?(ctx: GatewayContext): PaymentMethod[];

  /** Cria o link de pagamento. */
  createCheckout(
    pedido: HostedCheckoutRequest,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult>;

  /**
   * As cobranças ligadas à nossa referência, da mais antiga para a mais nova.
   *
   * Lança `GatewayResourceNotFoundError` quando a casa não conhece a
   * referência — e não devolve lista vazia: "nunca virou cobrança" e "virou
   * cobrança nenhuma vez" são a mesma coisa aqui, mas quem chama precisa poder
   * distinguir isso de uma casa fora do ar.
   *
   * @param checkoutId o id que `createCheckout` devolveu. Só o PayPal usa: a
   * API de Orders não busca por referência, só pelo id do pedido.
   */
  listCharges(
    referenceId: string,
    ctx: GatewayContext,
    checkoutId?: string,
  ): Promise<GatewayCharge[]>;

  /**
   * Invalida um checkout que não vale mais. Melhor esforço: a casa que não
   * oferece a operação não deve falhar por isso — o link antigo expira
   * sozinho, e o fluxo não pode travar por causa da faxina.
   */
  inactivateCheckout(checkoutId: string, ctx: GatewayContext): Promise<void>;

  /**
   * A notificação é mesmo desta casa?
   *
   * Chamada **antes** de qualquer interpretação do corpo. Devolver `false`
   * aqui é o que impede alguém de mandar um POST anunciando que a inscrição
   * dele está paga — e é por isso que o método é obrigatório mesmo nas casas
   * que não assinam: lá ele confere o segredo da URL, que o registry já
   * validou, e devolve `true` deixando o comentário explícito de por quê.
   */
  verifyWebhook(req: WebhookRequest, ctx: GatewayContext): boolean;

  /** Traduz a notificação para o vocabulário do sistema. */
  parseWebhook(
    req: WebhookRequest,
    ctx: GatewayContext,
  ): Promise<GatewayWebhookEvent>;

  /**
   * Bate na casa com a credencial cadastrada, para a tela poder dizer "está
   * valendo" em vez de a igreja descobrir no primeiro inscrito que tentou pagar.
   */
  healthCheck(ctx: GatewayContext): Promise<GatewayHealth>;
}

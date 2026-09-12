import {
  CheckoutStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
  PaymentStatus,
} from '@prisma/client';

/**
 * Um campo de credencial que a casa exige.
 *
 * A lista de campos mora no adapter, e não na tela nem no DTO: é o adapter que
 * sabe se a casa quer um bearer token, um par de chaves ou só um apelido. A
 * tela de configurações desenha o formulário a partir daqui, e a validação do
 * backend confere contra a mesma lista — acrescentar um campo é mexer em um
 * arquivo só.
 */
export interface CredentialField {
  key: string;
  label: string;
  required: boolean;
  /**
   * Segredo de verdade: vai cifrado e nunca mais volta em claro para a tela,
   * só a máscara. Campo não-segredo (um apelido público, uma URL) volta
   * inteiro, porque escondê-lo só atrapalharia quem administra.
   */
  secret: boolean;
  help?: string;
  placeholder?: string;
  /**
   * Quando o campo é uma URL de API, os únicos domínios aceitos.
   *
   * Sem isto, um admin (ou quem tomasse a conta de um) apontaria a integração
   * para um endereço próprio e o servidor entregaria a credencial da igreja na
   * primeira cobrança — e, pior, faria requisições autenticadas para onde
   * mandassem, alcançando de dentro da rede o que não é alcançável de fora.
   */
  allowedHostSuffixes?: string[];
}

/** O que o adapter anuncia sobre si para a tela e para o registry */
export interface PaymentGatewayDescriptor {
  provider: PaymentProvider;
  /** Nome comercial, como a pessoa reconhece na tela */
  label: string;
  /** Uma linha sobre o que a integração faz, para a tela de configurações */
  summary: string;
  /** O que a casa aceita no checkout hospedado */
  paymentMethods: PaymentMethod[];
  fields: CredentialField[];
  docsUrl: string;
  /**
   * A casa assina a notificação com um segredo próprio?
   *
   * Quando não assina, a única coisa que separa um retorno legítimo de um
   * "foi pago" forjado é o segredo da URL — e a tela precisa dizer isso a
   * quem cadastra, porque a URL passa a ser material sensível.
   */
  signsWebhook: boolean;
  /**
   * Sufixos de notificação que a casa precisa ter cadastrados. A URL completa
   * é montada em `PaymentProviderService`, que é quem conhece o segredo.
   */
  webhookChannels: { key: string; label: string }[];
}

/**
 * Tudo o que o adapter precisa para falar com a casa em nome de uma igreja.
 *
 * As credenciais chegam já abertas: quem decifra é o registry, um lugar só, e
 * o adapter nunca toca no envelope nem na chave.
 */
export interface GatewayContext {
  churchId: string;
  configId: string;
  provider: PaymentProvider;
  mode: PaymentProviderMode;
  credentials: Record<string, string>;
}

/** Um item do checkout, em centavos — nenhuma casa aceita reais fracionados */
export interface HostedCheckoutItem {
  referenceId: string;
  name: string;
  description: string;
  quantity: number;
  unitAmountCents: number;
}

/**
 * O pedido de checkout, do jeito que o sistema pensa — não do jeito de
 * nenhuma casa em particular. Traduzir isto para o formato de cada uma é o
 * trabalho do adapter.
 */
export interface HostedCheckoutRequest {
  /** Nosso identificador da cobrança. Volta no retorno da casa e é por ele que o pagamento é reencontrado. */
  referenceId: string;
  eventId: string;
  eventName: string;
  customer: {
    name: string;
    email: string;
    taxId: string;
    phone: { country: string; area: string; number: string };
  };
  items: HostedCheckoutItem[];
  discountCents: number;
  expiresAt: Date;
  /** Para onde a casa avisa que o dinheiro entrou (já com o segredo) */
  paymentNotificationUrl: string;
  /** Para onde a casa avisa que o checkout mudou de estado */
  checkoutNotificationUrl: string;
  /** Para onde o inscrito volta depois de pagar */
  redirectUrl: string;
  softDescriptor: string;
}

export interface HostedCheckoutResult {
  /** Identificador do checkout na casa — é por ele que ele é invalidado depois */
  checkoutId: string;
  /** O link que o inscrito abre */
  payUrl: string;
  /** A resposta crua, para o `payload` do pagamento e para depuração */
  raw: unknown;
}

/**
 * Uma cobrança como o sistema a entende, traduzida da casa.
 *
 * `createdAt` existe porque o fluxo escolhe a mais recente quando a casa
 * devolve várias para a mesma referência (uma tentativa recusada seguida de
 * uma aprovada, por exemplo).
 */
export interface GatewayCharge {
  status: PaymentStatus;
  method: PaymentMethod;
  createdAt: Date;
  /**
   * Quanto entrou, em centavos. Nulo quando a casa não informa.
   *
   * "Foi pago" sozinho não é resposta suficiente: a InfinitePay cria cobrança
   * sem credencial nenhuma — o `handle` é público e o valor é escolhido por
   * quem chama —, então qualquer um mintava uma cobrança de um centavo com a
   * nossa referência e a inscrição de R$ 300 entrava como quitada. Ver
   * `conferirValorPago`.
   */
  paidAmountCents?: number | null;
  raw: unknown;
}

/** A notificação que chegou, antes de qualquer interpretação */
export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /**
   * O corpo exatamente como chegou. Não serve reserializar `body`: o PagBank
   * e o Pagar.me assinam os bytes, e `JSON.stringify` reordena chaves e
   * normaliza espaços — a assinatura conferida sobre o corpo remontado falha
   * mesmo quando a notificação é legítima.
   */
  rawBody: Buffer;
  body: any;
  query: Record<string, any>;
}

/** O que a notificação quis dizer, já traduzido */
export type GatewayWebhookEvent =
  | {
      kind: 'payment';
      referenceId: string;
      status: PaymentStatus;
      method: PaymentMethod;
      /** Quanto entrou, em centavos; ver `GatewayCharge.paidAmountCents` */
      paidAmountCents?: number | null;
      payload: unknown;
    }
  | { kind: 'checkout'; checkoutId: string; status: CheckoutStatus }
  /** Notificação legítima que não muda nada aqui (um "pedido criado", por ex.) */
  | { kind: 'ignored'; reason: string };

/** Resultado do "testar conexão" da tela de configurações */
export interface GatewayHealth {
  ok: boolean;
  message: string;
  /** Nome da conta na casa, quando a API devolve — confirma que é a conta certa */
  account?: string;
}

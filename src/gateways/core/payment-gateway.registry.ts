import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentProvider, PaymentProviderConfig } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SecretCryptoService } from 'src/crypto/secret-crypto.service';
import { PAYMENT_GATEWAYS, PaymentGateway } from './payment-gateway.interface';
import { GatewayContext, PaymentGatewayDescriptor } from './gateway.types';

/** A casa, a credencial aberta e a linha do banco, juntas */
export interface GatewayResolvido {
  gateway: PaymentGateway;
  context: GatewayContext;
  config: PaymentProviderConfig;
  /**
   * O segredo da URL de notificação, em claro. Fica fora de `context` de
   * propósito: é um segredo **do sistema**, e nenhum adapter tem o que fazer
   * com ele — quem monta a URL é o serviço de pagamento.
   */
  webhookSecret: string;
}

/**
 * O ponto único que responde "por onde esta igreja cobra, e com que chave".
 *
 * Tudo o que envolve credencial passa por aqui: a leitura do banco, a abertura
 * do envelope e a escolha do adapter. Os adapters não conhecem Prisma e o
 * serviço de pagamento não conhece criptografia — se um dia a credencial sair
 * do banco e for para um cofre externo, muda este arquivo e mais nenhum.
 */
@Injectable()
export class PaymentGatewayRegistry {
  private readonly porProvider: Map<PaymentProvider, PaymentGateway>;

  constructor(
    @Inject(PAYMENT_GATEWAYS) gateways: PaymentGateway[],
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
  ) {
    this.porProvider = new Map(
      gateways.map((gateway) => [gateway.descriptor.provider, gateway]),
    );
  }

  /** O catálogo que a tela de configurações desenha */
  descriptors(): PaymentGatewayDescriptor[] {
    return [...this.porProvider.values()].map((g) => g.descriptor);
  }

  descriptor(provider: PaymentProvider): PaymentGatewayDescriptor {
    return this.gateway(provider).descriptor;
  }

  gateway(provider: PaymentProvider): PaymentGateway {
    const gateway = this.porProvider.get(provider);

    if (!gateway) {
      // Acontece quando o enum do banco anda na frente dos adapters — uma
      // credencial gravada numa versão mais nova e lida por uma mais velha.
      throw new ServiceUnavailableException(
        `A integração ${provider} não está disponível nesta versão do sistema`,
      );
    }

    return gateway;
  }

  /**
   * Por onde esta igreja cobra agora.
   *
   * Exige `enabled` **e** `isDefault`: desligar a casa tem que parar de gerar
   * cobrança nova de imediato, sem depender de alguém lembrar de trocar o
   * padrão antes.
   */
  async paraIgreja(churchId: string): Promise<GatewayResolvido> {
    const config = await this.prisma.paymentProviderConfig.findFirst({
      where: { churchId, enabled: true, isDefault: true },
    });

    if (!config) {
      throw new ServiceUnavailableException(
        'Pagamentos online estão temporariamente indisponíveis. Contate o suporte!',
      );
    }

    return this.abrir(config);
  }

  /** A igreja tem alguma casa ligada? Usado para não oferecer o botão de pagar. */
  async igrejaCobraOnline(churchId: string): Promise<boolean> {
    const total = await this.prisma.paymentProviderConfig.count({
      where: { churchId, enabled: true, isDefault: true },
    });

    return total > 0 && this.crypto.disponivel;
  }

  /**
   * A configuração exata que gerou um checkout.
   *
   * É o que a reconciliação e o retorno da casa usam: perguntar o status com a
   * credencial de hoje quando a cobrança nasceu na credencial de ontem daria
   * "não existe" — e o pagamento pago ficaria parado em WAITING.
   */
  async porConfigId(configId: string): Promise<GatewayResolvido> {
    const config = await this.prisma.paymentProviderConfig.findUnique({
      where: { id: configId },
    });

    if (!config) {
      throw new NotFoundException('Configuração de pagamento não encontrada');
    }

    return this.abrir(config);
  }

  /**
   * A configuração de uma casa numa igreja, ligada ou não.
   *
   * A distinção importa: `enabled` governa cobrança nova, e não o retorno de
   * uma cobrança que já saiu. Desligar o gateway com dez inscritos no meio do
   * pagamento não pode fazer o sistema recusar a notificação de que eles
   * pagaram.
   */
  async porIgrejaEProvider(
    churchId: string,
    provider: PaymentProvider,
  ): Promise<GatewayResolvido | null> {
    const config = await this.prisma.paymentProviderConfig.findUnique({
      where: { churchId_provider: { churchId, provider } },
    });

    return config ? this.abrir(config) : null;
  }

  /**
   * A configuração dona do segredo que veio na URL de notificação.
   *
   * A busca é pelo hash: o segredo em claro não está no banco, então nem quem
   * o lê consegue montar a URL de ninguém. O `provider` entra no `where` de
   * propósito — sem ele, um segredo vazado de uma casa valeria como entrada
   * para o interpretador de outra.
   */
  async porSegredoDeWebhook(
    provider: PaymentProvider,
    segredo: string,
  ): Promise<GatewayResolvido | null> {
    if (!segredo || segredo.length < 16) return null;

    const config = await this.prisma.paymentProviderConfig.findFirst({
      where: {
        provider,
        webhookSecretHash: this.crypto.hashDeWebhook(segredo),
      },
    });

    return config ? this.abrir(config) : null;
  }

  /**
   * O segredo que vai na URL de notificação desta configuração, em claro.
   *
   * Ele mora dentro do mesmo envelope cifrado das credenciais — a coluna
   * `webhookSecretHash` existe só para a rota encontrar a configuração por
   * chave. Guardar apenas o hash obrigaria a tela a mostrar a URL uma única
   * vez, na criação, e quem perdesse teria que rotacionar o segredo e voltar
   * ao painel do provedor para recadastrar.
   *
   * Só a tela de configurações chama isto, e ela já é de admin da igreja.
   */
  segredoDeWebhook(config: PaymentProviderConfig): string {
    return this.abrirCofre(config)[CHAVE_DO_WEBHOOK] ?? '';
  }

  /**
   * Abre o envelope da credencial.
   *
   * O contexto do selo é `churchId:provider`, o mesmo usado ao cifrar: um
   * envelope movido para a linha de outra igreja não abre, então escrever
   * direto no banco não é suficiente para desviar a cobrança de ninguém.
   */
  private abrir(config: PaymentProviderConfig): GatewayResolvido {
    const cofre = this.abrirCofre(config);

    // O segredo da URL sai antes de chegar ao adapter: ele é do sistema, não
    // da casa, e nenhum adapter tem o que fazer com ele.
    const { [CHAVE_DO_WEBHOOK]: segredo, ...credentials } = cofre;

    return {
      gateway: this.gateway(config.provider),
      config,
      webhookSecret: segredo ?? '',
      context: {
        churchId: config.churchId,
        configId: config.id,
        provider: config.provider,
        mode: config.mode,
        credentials,
      },
    };
  }

  private abrirCofre(config: PaymentProviderConfig): Record<string, string> {
    return this.crypto.decifrar<Record<string, string>>(
      config.credentials,
      contextoDoSelo(config.churchId, config.provider),
    );
  }
}

/**
 * Onde o segredo da URL de notificação mora dentro do envelope.
 *
 * Prefixo `__` para não colidir com campo de credencial nenhum, e a validação
 * de `PaymentProviderService` recusa qualquer chave que não esteja no
 * descriptor — então não há como alguém injetar este nome pelo formulário e
 * sobrescrever o segredo de fora.
 */
export const CHAVE_DO_WEBHOOK = '__webhook';

/**
 * O dado autenticado que amarra o envelope ao dono.
 *
 * Fica aqui, e não dentro do serviço de criptografia, porque é uma regra deste
 * domínio: quem cifra (a tela de configurações) e quem decifra (este registry)
 * precisam montar exatamente a mesma string, e ela precisa ser a mesma para
 * sempre — mudar o formato depois invalidaria toda credencial já gravada.
 */
export function contextoDoSelo(
  churchId: string,
  provider: PaymentProvider,
): string {
  return `payment-credentials:${churchId}:${provider}`;
}

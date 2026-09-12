import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  GatewayResolvido,
  PaymentGatewayRegistry,
} from 'src/gateways/core/payment-gateway.registry';
import { WebhookRequest } from 'src/gateways/core/gateway.types';
import { CANAL_DE_CHECKOUT } from 'src/gateways/core/webhook-url';

/**
 * O porteiro do dinheiro que entra sozinho.
 *
 * Toda notificação de gateway passa por aqui, e o desenho é o mesmo para as
 * quatro casas, em três perguntas na ordem:
 *
 * 1. **De quem é esta URL?** O segredo no caminho aponta uma configuração —
 *    uma igreja, uma casa. Segredo desconhecido não chega nem a ser lido.
 * 2. **Veio mesmo de lá?** O adapter confere a assinatura da casa. Quem não
 *    assina (InfinitePay) resolve isso confirmando o pagamento na API dela.
 * 3. **O que isso quer dizer aqui?** Só então o corpo é traduzido, e sempre
 *    com o recorte da configuração que se autenticou: um retorno de uma igreja
 *    não dá baixa em cobrança de outra.
 *
 * Antes disso a rota era aberta: um POST com o `reference_id` certo marcava
 * uma inscrição como paga, sem credencial nenhuma.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly registry: PaymentGatewayRegistry,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * A rota nova, igual para todas as casas:
   * `/webhooks/<casa>/<segredo>/<canal>`.
   */
  async receber(
    provider: PaymentProvider,
    segredo: string,
    canal: string,
    req: WebhookRequest,
  ) {
    const resolvido = await this.registry.porSegredoDeWebhook(
      provider,
      segredo,
    );

    if (!resolvido) {
      // 404 e não 401: a resposta fica igual à de uma rota que não existe, e
      // quem estiver tentando adivinhar segredo não recebe a confirmação de
      // que errou por pouco.
      this.logger.warn(
        `Notificação ${provider} recusada: segredo não corresponde a nenhuma configuração.`,
      );
      throw new NotFoundException();
    }

    return this.processar(resolvido, canal, req);
  }

  /**
   * As URLs antigas do PagBank (`/webhooks/pagbank/payments` e
   * `/webhooks/pagbank/checkouts`), sem segredo no caminho.
   *
   * Continuam de pé porque estão cadastradas nos checkouts que já saíram: eles
   * vencem em uma hora, mas derrubar as rotas agora perderia o retorno de quem
   * está com a tela de pagamento aberta neste momento.
   *
   * Não são um buraco: a configuração é encontrada pela cobrança que o corpo
   * cita, e a assinatura do PagBank é conferida do mesmo jeito. O que falta
   * aqui é só o segredo da URL — e ele é a segunda tranca, não a única.
   */
  async receberLegadoPagbank(canal: string, req: WebhookRequest) {
    const referencia = this.referenciaDoCorpo(canal, req);

    if (!referencia) {
      return { received: true, ignored: 'notificação sem referência' };
    }

    const checkout = await this.prisma.paymentCheckout.findFirst({
      where:
        canal === CANAL_DE_CHECKOUT
          ? { checkoutId: referencia, provider: PaymentProvider.PAGBANK }
          : { referenceId: referencia, provider: PaymentProvider.PAGBANK },
      orderBy: { createdAt: 'desc' },
      select: { configId: true, payment: { select: { eventId: true } } },
    });

    const resolvido = await this.configDoCheckoutLegado(checkout);

    if (!resolvido) {
      this.logger.warn(
        `Notificação PagBank (rota antiga) recusada: nenhuma configuração encontrada para ${referencia}.`,
      );
      throw new NotFoundException();
    }

    return this.processar(resolvido, canal, req);
  }

  // ----------------------------------------------------------------------

  private async processar(
    resolvido: GatewayResolvido,
    canal: string,
    req: WebhookRequest,
  ) {
    const { gateway, context, config } = resolvido;

    if (!gateway.verifyWebhook(req, context)) {
      this.logger.warn(
        `Notificação ${config.provider} recusada: assinatura inválida (igreja ${config.churchId}).`,
      );
      throw new NotFoundException();
    }

    // A partir daqui a notificação é legítima. O carimbo alimenta o aviso de
    // "configurado mas nunca recebeu retorno" na tela de configurações — o
    // sintoma de URL cadastrada errada do lado de lá.
    await this.marcarRecebimento(config.id);

    const evento = await gateway.parseWebhook(req, context);
    const escopo = {
      provider: config.provider,
      configId: config.id,
      churchId: config.churchId,
    };

    if (evento.kind === 'ignored') {
      return { received: true, ignored: evento.reason };
    }

    if (evento.kind === 'checkout') {
      await this.paymentService.updatePaymentCheckoutWebhook(
        evento.checkoutId,
        evento.status,
        escopo,
      );

      return { received: true };
    }

    await this.paymentService.updatePaymentWebhook(
      evento.referenceId,
      evento.status,
      evento.method,
      evento.payload,
      escopo,
      evento.paidAmountCents,
    );

    return { received: true };
  }

  /**
   * Nunca derruba a notificação.
   *
   * O carimbo é conveniência de tela; falhar aqui e devolver erro faria a casa
   * reenviar um retorno que já foi aplicado.
   */
  private async marcarRecebimento(configId: string) {
    try {
      await this.prisma.paymentProviderConfig.update({
        where: { id: configId },
        data: { lastWebhookAt: new Date() },
      });
    } catch (erro: any) {
      this.logger.warn(
        `Não foi possível carimbar o recebimento da notificação: ${erro?.message}`,
      );
    }
  }

  private async configDoCheckoutLegado(
    checkout: { configId: string | null } | null,
  ): Promise<GatewayResolvido | null> {
    if (!checkout) return null;

    if (checkout.configId) {
      return this.registry.porConfigId(checkout.configId);
    }

    // Linha anterior à coluna `configId`: a credencial é a do PagBank da
    // igreja dona do evento daquela cobrança.
    const igreja = await this.igrejaDoCheckoutLegado(checkout);
    if (!igreja) return null;

    return this.registry.porIgrejaEProvider(igreja, PaymentProvider.PAGBANK);
  }

  private async igrejaDoCheckoutLegado(checkout: any): Promise<string | null> {
    const eventId = checkout?.payment?.eventId;
    if (!eventId) return null;

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { churchId: true },
    });

    return event?.churchId ?? null;
  }

  /** O que a notificação antiga do PagBank cita: a referência ou o checkout */
  private referenciaDoCorpo(canal: string, req: WebhookRequest): string | null {
    const body = req.body ?? {};

    if (canal === CANAL_DE_CHECKOUT) {
      return body.id ?? null;
    }

    const charges: any[] = body.charges ?? [];
    return charges[0]?.reference_id ?? null;
  }
}

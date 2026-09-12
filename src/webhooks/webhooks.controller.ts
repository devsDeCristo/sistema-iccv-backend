import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { ProviderSlugPipe } from 'src/payment-providers/provider-slug.pipe';
import { PaymentProvider } from '@prisma/client';
import { WebhookRequest } from 'src/gateways/core/gateway.types';
import {
  CANAL_DE_CHECKOUT,
  CANAL_DE_PAGAMENTO,
} from 'src/gateways/core/webhook-url';

/**
 * A porta por onde o gateway avisa que o dinheiro entrou.
 *
 * É pública por necessidade — quem chama é o servidor da casa, que não tem
 * como se autenticar com um JWT nosso. Quem faz o papel de credencial é o
 * segredo no caminho, somado à assinatura que cada casa põe na notificação.
 * As duas conferências acontecem em `WebhooksService`, antes de qualquer
 * leitura do corpo.
 *
 * As rotas fora do Swagger de propósito: publicar o formato do caminho de
 * notificação não ajuda ninguém que já tem a URL, e ajuda quem não tem.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * Rota antiga do PagBank, mantida para os checkouts que já saíram com ela
   * cadastrada. Declarada **antes** da genérica: o Nest casa por ordem, e sem
   * isso `/webhooks/pagbank/checkouts` cairia na rota de segredo com
   * `segredo = "checkouts"`.
   */
  @ApiExcludeEndpoint()
  @Post('/pagbank/checkouts')
  @HttpCode(200)
  async handlePagbankLegado(@Req() req: Request) {
    return this.webhooksService.receberLegadoPagbank(
      CANAL_DE_CHECKOUT,
      paraWebhookRequest(req),
    );
  }

  @ApiExcludeEndpoint()
  @Post('/pagbank/payments')
  @HttpCode(200)
  async handlePagbankPaymentsLegado(@Req() req: Request) {
    return this.webhooksService.receberLegadoPagbank(
      CANAL_DE_PAGAMENTO,
      paraWebhookRequest(req),
    );
  }

  /**
   * A rota de todas as casas: `/webhooks/<casa>/<segredo>/<canal>`.
   *
   * O canal fica no fim e não no meio porque o segredo é o que o roteador usa
   * para achar a configuração — e ele precisa estar num lugar fixo,
   * independentemente de a casa ter um canal ou três.
   */
  @ApiOperation({ summary: 'Notificação do gateway de pagamento' })
  @ApiExcludeEndpoint()
  @Post(':provider/:secret/:channel')
  @HttpCode(200)
  async receber(
    @Param('provider', ProviderSlugPipe) provider: PaymentProvider,
    @Param('secret') secret: string,
    @Param('channel') channel: string,
    @Req() req: Request,
  ) {
    return this.webhooksService.receber(
      provider,
      secret,
      channel,
      paraWebhookRequest(req),
    );
  }
}

/**
 * O corpo cru vem do `verify` do parser de JSON, em `main.ts`.
 *
 * Sem ele a conferência de assinatura do PagBank e da Ton não tem como
 * funcionar: as duas assinam os bytes que enviaram, e `JSON.stringify` do
 * corpo já interpretado reordena chaves e normaliza espaços — o hash não bate
 * nem quando a notificação é legítima.
 */
function paraWebhookRequest(req: Request): WebhookRequest {
  return {
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody: (req as any).rawBody ?? Buffer.alloc(0),
    body: req.body,
    query: req.query as Record<string, any>,
  };
}

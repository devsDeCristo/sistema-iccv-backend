import { Injectable, Logger } from '@nestjs/common';
import { PaymentProviderMode } from '@prisma/client';
import { criarHttp, falhaDoGateway } from '../core/gateway-http';

/**
 * Sandbox e produção são endereços diferentes, e a credencial de um não vale
 * no outro — o `mode` da configuração escolhe a base.
 */
const BASES: Record<PaymentProviderMode, string> = {
  PRODUCTION: 'https://api-m.paypal.com',
  SANDBOX: 'https://api-m.sandbox.paypal.com',
};

export interface PayPalCredenciais {
  clientId: string;
  clientSecret: string;
}

@Injectable()
export class PayPalClient {
  private readonly logger = new Logger(PayPalClient.name);

  /**
   * Troca Client ID + Secret por um token OAuth.
   *
   * Lança o erro cru do axios de propósito: o teste de conexão lê o status
   * (401 é credencial errada ou de outro ambiente). Nas operações, quem chama
   * está dentro de um `try` que passa por `falhaDoGateway`.
   *
   * ponytail: um token por operação (uma chamada a mais); cachear por
   * configuração se o PayPal começar a responder 429 no /oauth2/token.
   */
  async token(
    cred: PayPalCredenciais,
    mode: PaymentProviderMode,
  ): Promise<{ access_token: string; app_id?: string }> {
    const { data } = await criarHttp(BASES[mode]).post(
      '/v1/oauth2/token',
      'grant_type=client_credentials',
      {
        auth: {
          username: (cred.clientId ?? '').trim(),
          password: (cred.clientSecret ?? '').trim(),
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    return data;
  }

  private async http(cred: PayPalCredenciais, mode: PaymentProviderMode) {
    const { access_token } = await this.token(cred, mode);

    return criarHttp(BASES[mode], {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * @param requestId a nossa referência, como `PayPal-Request-Id`: a mesma
   * chamada repetida (um retry de rede) devolve o pedido já criado em vez de
   * abrir outro.
   */
  async createOrder(
    payload: Record<string, unknown>,
    cred: PayPalCredenciais,
    mode: PaymentProviderMode,
    requestId: string,
  ) {
    try {
      const http = await this.http(cred, mode);
      const { data } = await http.post('/v2/checkout/orders', payload, {
        headers: { 'PayPal-Request-Id': requestId },
      });
      return data;
    } catch (err: any) {
      falhaDoGateway(this.logger, 'PayPal', 'criar pedido', err);
    }
  }

  /** `null` quando a conta não conhece o pedido — ou ele já expirou */
  async getOrder(
    orderId: string,
    cred: PayPalCredenciais,
    mode: PaymentProviderMode,
  ) {
    try {
      const http = await this.http(cred, mode);
      const { data } = await http.get(
        `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      );
      return data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      falhaDoGateway(this.logger, 'PayPal', 'obter pedido', err);
    }
  }

  /**
   * Captura um pedido aprovado — é aqui que o dinheiro se move.
   *
   * 422 não é falha de comunicação: é o PayPal dizendo "não dá para capturar
   * este" (já capturado por uma chamada concorrente, cartão recusado na hora,
   * pedido ainda não aprovado). Vira aviso, e quem chama relê o pedido para
   * saber em que estado ele ficou. Qualquer outro erro sobe — no webhook, isso
   * devolve erro ao PayPal, que reenvia a notificação mais tarde.
   */
  async captureOrder(
    orderId: string,
    cred: PayPalCredenciais,
    mode: PaymentProviderMode,
  ): Promise<void> {
    try {
      const http = await this.http(cred, mode);
      await http.post(
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        {},
      );
    } catch (err: any) {
      if (err?.response?.status === 422) {
        this.logger.warn(
          `PayPal — pedido ${orderId} não capturado: ${JSON.stringify(
            err.response.data?.details ?? err.response.data,
          )}`,
        );
        return;
      }
      falhaDoGateway(this.logger, 'PayPal', 'capturar pedido', err);
    }
  }
}

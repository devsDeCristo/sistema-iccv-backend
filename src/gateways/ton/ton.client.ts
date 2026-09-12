import { Injectable, Logger } from '@nestjs/common';
import { PaymentProviderMode } from '@prisma/client';
import { criarHttp, falhaDoGateway } from '../core/gateway-http';

/**
 * A Ton é a marca de maquininha da Stone, e o checkout hospedado do grupo é o
 * do Pagar.me v5 — é essa API que a conta Ton/Stone habilita e é contra ela
 * que este cliente fala.
 */
const BASES: Record<PaymentProviderMode, string> = {
  PRODUCTION: 'https://api.pagar.me/core/v5',
  SANDBOX: 'https://sdx-api.pagar.me/core/v5',
};

export interface TonCredenciais {
  secretKey: string;
  /** Assinatura das notificações, quando a conta a tiver configurado */
  webhookSecret?: string;
  maxInstallments?: string;
  /** Para uma base própria; vazio usa a oficial do modo */
  baseUrl?: string;
}

@Injectable()
export class TonClient {
  private readonly logger = new Logger(TonClient.name);

  /**
   * Basic com a chave secreta no usuário e senha vazia — é como o Pagar.me
   * autentica. O `User-Agent` é exigido: sem ele a API recusa a chamada.
   */
  private http(cred: TonCredenciais, mode: PaymentProviderMode) {
    const basic = Buffer.from(`${cred.secretKey.trim()}:`).toString('base64');

    return criarHttp(cred.baseUrl?.trim() || BASES[mode], {
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ic-backend',
      },
    });
  }

  async createOrder(
    payload: Record<string, unknown>,
    cred: TonCredenciais,
    mode: PaymentProviderMode,
  ) {
    try {
      const { data } = await this.http(cred, mode).post('/orders', payload);
      return data;
    } catch (err: any) {
      falhaDoGateway(this.logger, 'Ton', 'criar pedido', err);
    }
  }

  /** Os pedidos com o nosso `code`. Vazio quando o link nunca virou pedido. */
  async findOrdersByCode(
    code: string,
    cred: TonCredenciais,
    mode: PaymentProviderMode,
  ): Promise<any[]> {
    try {
      const { data } = await this.http(cred, mode).get('/orders', {
        params: { code, size: 10 },
      });

      return data?.data ?? [];
    } catch (err: any) {
      if (err?.response?.status === 404) return [];
      falhaDoGateway(this.logger, 'Ton', 'consultar pedidos', err);
    }
  }

  async getOrder(
    orderId: string,
    cred: TonCredenciais,
    mode: PaymentProviderMode,
  ) {
    try {
      const { data } = await this.http(cred, mode).get(`/orders/${orderId}`);
      return data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      falhaDoGateway(this.logger, 'Ton', 'obter pedido', err);
    }
  }

  /**
   * Fecha o pedido como cancelado. Melhor esforço, e por isso o erro só vira
   * aviso: um pedido que a API se recusa a fechar (já pago, já cancelado) não
   * pode travar a criação do checkout novo.
   */
  async cancelOrder(
    orderId: string,
    cred: TonCredenciais,
    mode: PaymentProviderMode,
  ) {
    try {
      await this.http(cred, mode).patch(`/orders/${orderId}/closed`, {
        status: 'canceled',
      });
    } catch (err: any) {
      this.logger.warn(
        `Ton — não foi possível cancelar o pedido ${orderId}: ${
          err?.response?.status ?? err?.message
        }`,
      );
    }
  }

  /** Uma listagem mínima só para saber se a chave é aceita */
  async ping(cred: TonCredenciais, mode: PaymentProviderMode) {
    const { data } = await this.http(cred, mode).get('/orders', {
      params: { size: 1 },
    });
    return data;
  }
}

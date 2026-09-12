import { Injectable, Logger } from '@nestjs/common';
import { criarHttp, falhaDoGateway } from '../core/gateway-http';

const BASE = 'https://api.checkout.infinitepay.io';

export interface InfinitePayCredenciais {
  /** O InfiniteTag da conta, com ou sem `$` */
  handle: string;
}

/** Resposta do `payment_check` — a fonte de verdade sobre o dinheiro */
export interface InfinitePayConferencia {
  success: boolean;
  paid: boolean;
  amount?: number;
  paid_amount?: number;
  installments?: number;
  capture_method?: string;
}

/**
 * A API de checkout da InfinitePay é pública: o `handle` identifica a conta e
 * não há token.
 *
 * Isso é seguro para criar links (um link criado por terceiro paga a conta da
 * igreja, não a dele), mas muda tudo no retorno: sem credencial não há
 * assinatura, e a notificação sozinha não prova nada. Por isso todo aviso de
 * pagamento é reconferido aqui pelo `payment_check` antes de virar baixa.
 */
@Injectable()
export class InfinitePayClient {
  private readonly logger = new Logger(InfinitePayClient.name);

  private http() {
    return criarHttp(BASE, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** O handle sem o `$`, que é como a API o espera */
  private handle(cred: InfinitePayCredenciais) {
    return cred.handle.trim().replace(/^\$/, '');
  }

  async createLink(
    payload: Record<string, unknown>,
    cred: InfinitePayCredenciais,
  ) {
    try {
      const { data } = await this.http().post('/links', {
        ...payload,
        handle: this.handle(cred),
      });
      return data;
    } catch (err: any) {
      falhaDoGateway(this.logger, 'InfinitePay', 'criar link', err);
    }
  }

  /**
   * Pergunta à InfinitePay se a cobrança foi mesmo paga.
   *
   * Devolve `null` quando a conta não conhece a referência — o caso do link
   * criado e nunca aberto, que não é erro.
   */
  async paymentCheck(
    cred: InfinitePayCredenciais,
    dados: { orderNsu: string; transactionNsu?: string; slug?: string },
  ): Promise<InfinitePayConferencia | null> {
    try {
      const { data } = await this.http().post('/payment_check', {
        handle: this.handle(cred),
        order_nsu: dados.orderNsu,
        ...(dados.transactionNsu && { transaction_nsu: dados.transactionNsu }),
        ...(dados.slug && { slug: dados.slug }),
      });

      return data ?? null;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      falhaDoGateway(this.logger, 'InfinitePay', 'conferir pagamento', err);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { criarHttp, falhaDoGateway } from '../core/gateway-http';

/**
 * Um endereço só para os dois ambientes.
 *
 * Quem separa sandbox de produção no Mercado Pago é a credencial (`TEST-…`
 * contra `APP_USR-…`), e não a URL — por isso não há mapa de bases aqui como
 * nas outras casas.
 */
const BASE = 'https://api.mercadopago.com';

export interface MercadoPagoCredenciais {
  accessToken: string;
  webhookSecret: string;
}

@Injectable()
export class MercadoPagoClient {
  private readonly logger = new Logger(MercadoPagoClient.name);

  private http(cred: MercadoPagoCredenciais) {
    return criarHttp(BASE, {
      headers: { Authorization: `Bearer ${cred.accessToken.trim()}` },
    });
  }

  /**
   * @param idempotencyKey a nossa referência. O Mercado Pago devolve a
   * preferência já criada quando a mesma chave chega de novo — é o que impede
   * que o duplo clique no botão de pagar abra duas cobranças para a mesma
   * inscrição.
   */
  async createPreference(
    payload: Record<string, unknown>,
    cred: MercadoPagoCredenciais,
    idempotencyKey: string,
  ) {
    try {
      const { data } = await this.http(cred).post(
        '/checkout/preferences',
        payload,
        { headers: { 'X-Idempotency-Key': idempotencyKey } },
      );
      return data;
    } catch (err: any) {
      falhaDoGateway(this.logger, 'Mercado Pago', 'criar preferência', err);
    }
  }

  /**
   * Encerra a preferência antes da hora.
   *
   * O Mercado Pago não tem "inativar": o que existe é a janela de validade, e
   * fechá-la no passado é o que derruba o link. Sem isso, o link antigo de um
   * checkout substituído continuaria pagável e a igreja receberia duas vezes.
   */
  async expirePreference(preferenceId: string, cred: MercadoPagoCredenciais) {
    try {
      const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      await this.http(cred).put(`/checkout/preferences/${preferenceId}`, {
        expires: true,
        expiration_date_to: ontem,
      });
    } catch (err: any) {
      falhaDoGateway(this.logger, 'Mercado Pago', 'expirar preferência', err);
    }
  }

  /** Os pagamentos amarrados à nossa referência, do mais antigo para o mais novo */
  async searchPayments(
    externalReference: string,
    cred: MercadoPagoCredenciais,
  ): Promise<any[]> {
    try {
      const { data } = await this.http(cred).get('/v1/payments/search', {
        params: {
          external_reference: externalReference,
          sort: 'date_created',
          criteria: 'asc',
        },
      });

      return data?.results ?? [];
    } catch (err: any) {
      falhaDoGateway(this.logger, 'Mercado Pago', 'consultar pagamentos', err);
    }
  }

  /**
   * O pagamento inteiro, buscado pelo id que veio na notificação.
   *
   * A notificação do Mercado Pago traz só o id — de propósito. O status vem
   * daqui, de uma chamada autenticada, e não do corpo do POST: acreditar no
   * corpo seria acreditar em quem o enviou.
   */
  async getPayment(paymentId: string, cred: MercadoPagoCredenciais) {
    try {
      const { data } = await this.http(cred).get(`/v1/payments/${paymentId}`);
      return data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      falhaDoGateway(this.logger, 'Mercado Pago', 'obter pagamento', err);
    }
  }

  /** Quem é o dono deste access token */
  async me(cred: MercadoPagoCredenciais) {
    const { data } = await this.http(cred).get('/users/me');
    return data;
  }

  /** Chave de idempotência para quando não houver uma referência natural */
  chaveAvulsa() {
    return randomUUID();
  }
}

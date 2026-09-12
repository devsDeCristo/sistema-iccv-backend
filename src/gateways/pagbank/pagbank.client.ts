import { Injectable, Logger } from '@nestjs/common';
import { PaymentProviderMode } from '@prisma/client';
import { CreatePagbankCheckoutDto } from './dto/create-checkout.dto';
import { criarHttp, falhaDoGateway } from '../core/gateway-http';
import { GatewayResourceNotFoundError } from '../core/gateway.errors';

/** Bases oficiais. O modo escolhe; a credencial de uma não vale na outra. */
const BASES: Record<PaymentProviderMode, string> = {
  PRODUCTION: 'https://api.pagseguro.com',
  SANDBOX: 'https://sandbox.api.pagseguro.com',
};

export interface PagbankCredenciais {
  token: string;
  /** Só para ambiente próprio de teste; vazio usa a base oficial do modo */
  baseUrl?: string;
}

/**
 * A conversa com o PagBank. Os caminhos e os corpos são os mesmos de antes —
 * o que mudou é de onde vem o token: da credencial da igreja, e não do `.env`.
 */
@Injectable()
export class PagbankClient {
  private readonly logger = new Logger(PagbankClient.name);

  private http(cred: PagbankCredenciais, mode: PaymentProviderMode) {
    return criarHttp(cred.baseUrl?.trim() || BASES[mode], {
      headers: { Authorization: `Bearer ${cred.token.trim()}` },
    });
  }

  async createCheckout(
    payload: CreatePagbankCheckoutDto,
    cred: PagbankCredenciais,
    mode: PaymentProviderMode,
  ) {
    try {
      const { data } = await this.http(cred, mode).post('/checkouts', payload);
      return data;
    } catch (err: any) {
      falhaDoGateway(this.logger, 'PagBank', 'criar checkout', err);
    }
  }

  async inactivateCheckout(
    checkoutId: string,
    cred: PagbankCredenciais,
    mode: PaymentProviderMode,
  ) {
    try {
      const { data } = await this.http(cred, mode).post(
        `/checkouts/${checkoutId}/inactivate`,
      );
      return data;
    } catch (err: any) {
      falhaDoGateway(this.logger, 'PagBank', 'inativar checkout', err);
    }
  }

  /**
   * As cobranças de uma referência.
   *
   * O 404 com `resource_not_found` não é falha: é o checkout que foi criado
   * aqui e abandonado lá antes de virar cobrança. Quem chama precisa seguir em
   * frente nesse caso, então ele vira um erro tipado em vez de um `if` sobre o
   * formato do corpo do PagBank espalhado pelo serviço de pagamento.
   */
  async getCharges(
    referenceId: string,
    cred: PagbankCredenciais,
    mode: PaymentProviderMode,
  ): Promise<any[]> {
    try {
      const { data } = await this.http(cred, mode).get('/charges', {
        params: { reference_id: referenceId },
      });

      // A API devolve a lista direta; o envelope `{ charges: [...] }` aparece
      // em algumas respostas e custa nada aceitar.
      return Array.isArray(data) ? data : data?.charges ?? [];
    } catch (err: any) {
      const naoExiste =
        err?.response?.status === 404 ||
        err?.response?.data?.error_messages?.[0]?.code === 'resource_not_found';

      if (naoExiste) {
        throw new GatewayResourceNotFoundError('PagBank', referenceId);
      }

      falhaDoGateway(this.logger, 'PagBank', 'consultar cobranças', err);
    }
  }

  /**
   * Chamada barata só para dizer se o token é aceito.
   *
   * Uma consulta de cobrança com referência inexistente serve: o token errado
   * responde 401, e o token certo responde 404 ou lista vazia — que é
   * exatamente a informação procurada, sem criar nada na conta de ninguém.
   */
  async ping(cred: PagbankCredenciais, mode: PaymentProviderMode) {
    // A API de checkout permite consultar por ID, mas não listar cobranças
    // por `reference_id`. Um ID inexistente em formato válido dá 404 para um
    // token aceito e evita criar qualquer recurso na conta.
    await this.http(cred, mode).get('/checkouts/CHEC_000000000000');
  }
}

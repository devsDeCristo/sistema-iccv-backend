import { HttpException } from '@nestjs/common';

/**
 * A casa respondeu "não conheço esta referência".
 *
 * Não é erro: é a resposta normal para um checkout que foi criado aqui e
 * abandonado lá antes de virar cobrança. O fluxo de criação depende de
 * distinguir isso de uma falha de verdade — com o checkout ativo no banco e
 * nenhuma ordem na casa, o certo é seguir e criar o novo, não abortar.
 *
 * Antes disso a distinção era feita lendo o corpo do erro do PagBank
 * (`error_messages[0].code === 'resource_not_found'`) dentro do serviço de
 * pagamento. Com quatro casas, cada uma com o seu formato de erro, o formato
 * tem que morrer no adapter.
 */
export class GatewayResourceNotFoundError extends Error {
  constructor(readonly provider: string, readonly reference: string) {
    super(`${provider}: recurso ${reference} não encontrado`);
    this.name = 'GatewayResourceNotFoundError';
  }
}

/**
 * A casa recusou ou não respondeu.
 *
 * `detalhes` guarda o corpo do erro para o log da aplicação; a mensagem que
 * sobe para a tela é a genérica — a resposta crua de um gateway costuma trazer
 * identificadores da conta, e ela chega até o inscrito.
 */
export class GatewayRequestError extends HttpException {
  constructor(
    readonly provider: string,
    readonly detalhes: unknown,
    status = 502,
  ) {
    super(
      `Não foi possível falar com ${provider} agora. Tente de novo em alguns minutos.`,
      status,
    );
    this.name = 'GatewayRequestError';
  }
}

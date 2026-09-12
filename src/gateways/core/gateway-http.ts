import { Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { GatewayRequestError } from './gateway.errors';

/**
 * 15s: o inscrito está olhando para um spinner esperando o link. Passou disso,
 * é melhor devolver erro e deixar ele tentar de novo do que segurar a conexão.
 */
const TIMEOUT_PADRAO = 15000;

/**
 * Um cliente HTTP por chamada, e não um por processo.
 *
 * O cliente antigo era criado uma vez no construtor e lia o token do `.env` a
 * cada requisição — o que funcionava justamente porque o token era um só. Com
 * a credencial vindo do banco e variando por igreja, um cliente compartilhado
 * guardaria o header de uma igreja e o usaria na cobrança da outra. Criar um
 * axios por chamada custa praticamente nada e fecha esse caminho.
 */
export function criarHttp(
  baseURL: string,
  config: AxiosRequestConfig = {},
): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: TIMEOUT_PADRAO,
    ...config,
    headers: { Accept: 'application/json', ...(config.headers ?? {}) },
  });
}

/**
 * Registra a falha com detalhe e sobe uma mensagem sem detalhe.
 *
 * A resposta de erro de um gateway costuma trazer identificador de conta,
 * fragmento de credencial e mensagem interna — e essa exceção chega até a tela
 * do inscrito. O que ele precisa saber é que não deu; o resto fica no log do
 * servidor, que só o operador lê.
 */
export function falhaDoGateway(
  logger: Logger,
  provider: string,
  contexto: string,
  err: any,
): never {
  logger.error(
    `${provider} — ${contexto} falhou: ${err?.response?.status ?? ''} ${
      typeof err?.response?.data === 'object'
        ? JSON.stringify(err.response.data)
        : err?.response?.data ?? err?.message
    }`,
  );

  throw new GatewayRequestError(provider, err?.response?.data);
}

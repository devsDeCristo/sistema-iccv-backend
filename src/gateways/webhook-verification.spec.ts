import { createHash, createHmac } from 'crypto';
import { PaymentProvider, PaymentProviderMode } from '@prisma/client';
import { PagbankGateway } from './pagbank/pagbank.gateway';
import { MercadoPagoGateway } from './mercadopago/mercadopago.gateway';
import { InfinitePayGateway } from './infinitepay/infinitepay.gateway';
import { TonGateway } from './ton/ton.gateway';
import { GatewayContext, WebhookRequest } from './core/gateway.types';

/**
 * A conferência da notificação é a tranca mais importante do sistema: é o
 * único caminho em que uma requisição sem login marca uma inscrição como paga.
 *
 * Antes destas integrações a rota do PagBank não conferia nada — um POST com o
 * `reference_id` certo bastava. Estes testes existem para que isso não volte
 * por descuido em nenhuma das quatro casas.
 */
function requisicao(
  corpo: unknown,
  headers: Record<string, string> = {},
  query: Record<string, any> = {},
): WebhookRequest {
  const rawBody = Buffer.from(JSON.stringify(corpo), 'utf8');
  return { headers, rawBody, body: corpo, query };
}

function contexto(
  provider: PaymentProvider,
  credentials: Record<string, string>,
): GatewayContext {
  return {
    churchId: 'igreja-1',
    configId: 'config-1',
    provider,
    mode: PaymentProviderMode.PRODUCTION,
    credentials,
  };
}

describe('PagBank — x-authenticity-token', () => {
  const gateway = new PagbankGateway({} as any);
  const ctx = contexto(PaymentProvider.PAGBANK, { token: 'tok-secreto' });
  const corpo = { charges: [{ reference_id: 'ref-1', status: 'PAID' }] };

  const assinar = (token: string, req: WebhookRequest) =>
    createHash('sha256')
      .update(`${token}-${req.rawBody.toString('utf8')}`)
      .digest('hex');

  it('aceita a notificação assinada com o token da igreja', () => {
    const req = requisicao(corpo);
    req.headers['x-authenticity-token'] = assinar('tok-secreto', req);

    expect(gateway.verifyWebhook(req, ctx)).toBe(true);
  });

  it('recusa notificação sem assinatura', () => {
    expect(gateway.verifyWebhook(requisicao(corpo), ctx)).toBe(false);
  });

  it('recusa assinatura feita com outro token', () => {
    const req = requisicao(corpo);
    req.headers['x-authenticity-token'] = assinar('tok-de-outro', req);

    expect(gateway.verifyWebhook(req, ctx)).toBe(false);
  });

  it('recusa quando o corpo foi trocado depois de assinado', () => {
    const req = requisicao(corpo);
    req.headers['x-authenticity-token'] = assinar('tok-secreto', req);

    // O ataque concreto: pegar uma notificação legítima de "recusado" e
    // trocar o status para "pago" mantendo a assinatura.
    req.rawBody = Buffer.from(
      JSON.stringify({ charges: [{ reference_id: 'ref-1', status: 'PAID' }] }),
    );
    req.rawBody = Buffer.from(req.rawBody.toString('utf8') + ' ');

    expect(gateway.verifyWebhook(req, ctx)).toBe(false);
  });
});

describe('Mercado Pago — x-signature', () => {
  const gateway = new MercadoPagoGateway({} as any);
  const ctx = contexto(PaymentProvider.MERCADO_PAGO, {
    accessToken: 'APP_USR-x',
    webhookSecret: 'segredo-mp',
  });

  const assinar = (
    segredo: string,
    id: string,
    requestId: string,
    ts: string,
  ) =>
    createHmac('sha256', segredo)
      .update(`id:${id};request-id:${requestId};ts:${ts};`)
      .digest('hex');

  function notificacao(segredo: string, id = 'pay-123') {
    const ts = '1700000000000';
    const requestId = 'req-1';

    return requisicao(
      { type: 'payment', data: { id } },
      {
        'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${assinar(segredo, id, requestId, ts)}`,
      },
      { 'data.id': id },
    );
  }

  it('aceita a notificação assinada com a chave da igreja', () => {
    expect(gateway.verifyWebhook(notificacao('segredo-mp'), ctx)).toBe(true);
  });

  it('recusa assinatura de outra chave', () => {
    expect(gateway.verifyWebhook(notificacao('segredo-errado'), ctx)).toBe(
      false,
    );
  });

  it('recusa quando o id do pagamento foi trocado', () => {
    const req = notificacao('segredo-mp', 'pay-123');
    req.query['data.id'] = 'pay-999';

    // Sem isto, quem interceptasse uma notificação legítima apontaria a
    // assinatura válida para a cobrança que quisesse quitar.
    expect(gateway.verifyWebhook(req, ctx)).toBe(false);
  });

  it('recusa quando a igreja não cadastrou a assinatura secreta', () => {
    const semSegredo = contexto(PaymentProvider.MERCADO_PAGO, {
      accessToken: 'APP_USR-x',
      webhookSecret: '',
    });

    // Fecha por falta de configuração em vez de abrir: sem o segredo não há
    // como distinguir a casa de qualquer outro remetente.
    expect(gateway.verifyWebhook(notificacao('qualquer'), semSegredo)).toBe(
      false,
    );
  });

  it('recusa cabeçalho de assinatura malformado', () => {
    const req = requisicao(
      { type: 'payment', data: { id: 'pay-1' } },
      { 'x-signature': 'lixo', 'x-request-id': 'req-1' },
      { 'data.id': 'pay-1' },
    );

    expect(gateway.verifyWebhook(req, ctx)).toBe(false);
  });
});

describe('Ton — X-Hub-Signature-256', () => {
  const gateway = new TonGateway({} as any);
  const corpo = { type: 'order.paid', data: { id: 'or_1', code: 'ref-1' } };

  const comSegredo = contexto(PaymentProvider.TON, {
    secretKey: 'sk_x',
    webhookSecret: 'segredo-ton',
  });

  const assinar = (segredo: string, req: WebhookRequest) =>
    `sha256=${createHmac('sha256', segredo).update(req.rawBody).digest('hex')}`;

  it('aceita a notificação assinada', () => {
    const req = requisicao(corpo);
    req.headers['x-hub-signature-256'] = assinar('segredo-ton', req);

    expect(gateway.verifyWebhook(req, comSegredo)).toBe(true);
  });

  it('recusa assinatura de outro segredo', () => {
    const req = requisicao(corpo);
    req.headers['x-hub-signature-256'] = assinar('outro', req);

    expect(gateway.verifyWebhook(req, comSegredo)).toBe(false);
  });

  it('recusa notificação sem assinatura quando a igreja cadastrou o segredo', () => {
    expect(gateway.verifyWebhook(requisicao(corpo), comSegredo)).toBe(false);
  });

  it('passa adiante quando a conta não tem assinatura configurada', () => {
    // Aqui a garantia não desaparece: ela se desloca para `parseWebhook`, que
    // vai buscar o pedido na API com a chave da igreja em vez de acreditar no
    // corpo. O segredo da URL continua sendo a primeira tranca.
    const semSegredo = contexto(PaymentProvider.TON, { secretKey: 'sk_x' });

    expect(gateway.verifyWebhook(requisicao(corpo), semSegredo)).toBe(true);
  });
});

describe('InfinitePay — sem assinatura', () => {
  const gateway = new InfinitePayGateway({} as any);

  it('anuncia que a casa não assina', () => {
    // A tela usa isto para avisar quem cadastra que a URL vira material
    // sensível — é o que sustenta a decisão de deixar `verifyWebhook` passar.
    expect(gateway.descriptor.signsWebhook).toBe(false);
  });

  it('não bloqueia na assinatura, porque a conferência é na API', () => {
    expect(gateway.verifyWebhook()).toBe(true);
  });
});

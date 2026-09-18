import { createHash, createHmac } from 'crypto';
import {
  PaymentProvider,
  PaymentProviderMode,
  PaymentStatus,
} from '@prisma/client';
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

/**
 * O PagBank não passa pela assinatura: a prova dele é a API.
 *
 * O `x-authenticity-token` existe e a fórmula está implementada, mas o token
 * que assina não é o token da API que cadastramos — medido na conta em uso,
 * nenhuma composição do hash confere. Por isso a baixa depende de uma chamada
 * autenticada nossa, e não do hash; o que estes testes protegem é que o corpo
 * nunca vire palavra final.
 */
describe('PagBank — a prova é a API, não a assinatura', () => {
  const ctx = contexto(PaymentProvider.PAGBANK, { token: 'tok-secreto' });

  const cobranca = (status: string, criadaEm = '2026-09-17T21:00:00Z') => ({
    id: 'CHAR_1',
    status,
    created_at: criadaEm,
    payment_method: { type: 'PIX' },
    amount: { summary: { paid: 28000 } },
  });

  const comCobrancas = (charges: any[]) => ({
    getCharges: jest.fn().mockResolvedValue(charges),
  });

  const assinar = (token: string, req: WebhookRequest) =>
    createHash('sha256')
      .update(`${token}-${req.rawBody.toString('utf8')}`)
      .digest('hex');

  it('não bloqueia na assinatura, porque a conferência é na API', () => {
    const gateway = new PagbankGateway({} as any);

    expect(gateway.verifyWebhook()).toBe(true);
  });

  it('usa o estado que a API devolve, não o que o corpo diz', async () => {
    const client = comCobrancas([cobranca('WAITING')]);
    const gateway = new PagbankGateway(client as any);

    // o corpo alega PAID; a API diz que ainda está aguardando
    const evento = await gateway.parseWebhook(
      requisicao({ charges: [{ reference_id: 'ref-1', status: 'PAID' }] }),
      ctx,
    );

    expect(client.getCharges).toHaveBeenCalledWith(
      'ref-1',
      expect.objectContaining({ token: 'tok-secreto' }),
      ctx.mode,
    );
    expect(evento).toMatchObject({
      kind: 'payment',
      referenceId: 'ref-1',
      status: PaymentStatus.WAITING,
      paidAmountCents: 28000,
    });
  });

  it('aceita o pagamento quando é a API que afirma que entrou', async () => {
    const gateway = new PagbankGateway(comCobrancas([cobranca('PAID')]) as any);

    const evento = await gateway.parseWebhook(
      requisicao({ reference_id: 'ref-1' }),
      ctx,
    );

    expect(evento).toMatchObject({
      kind: 'payment',
      status: PaymentStatus.PAID,
    });
  });

  it('ignora quando a casa não conhece a referência', async () => {
    const gateway = new PagbankGateway(comCobrancas([]) as any);

    const evento = await gateway.parseWebhook(
      requisicao({ reference_id: 'ref-1' }),
      ctx,
    );

    expect(evento).toMatchObject({ kind: 'ignored' });
  });

  it('ignora aviso de checkout sem assinatura, que é o que a API não confere', async () => {
    const client = comCobrancas([cobranca('PAID')]);
    const gateway = new PagbankGateway(client as any);

    const evento = await gateway.parseWebhook(
      requisicao({ id: 'CHEC_1', status: 'PAID' }),
      ctx,
    );

    expect(evento).toMatchObject({ kind: 'ignored' });
    expect(client.getCharges).not.toHaveBeenCalled();
  });

  it('aceita o aviso de checkout quando ele vem assinado', async () => {
    const gateway = new PagbankGateway({} as any);
    const req = requisicao({ id: 'CHEC_1', status: 'PAID' });
    req.headers['x-authenticity-token'] = assinar('tok-secreto', req);

    const evento = await gateway.parseWebhook(req, ctx);

    expect(evento).toMatchObject({ kind: 'checkout', checkoutId: 'CHEC_1' });
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

import { PaymentProviderMode } from '@prisma/client';
import { criarHttp } from '../core/gateway-http';
import { PayPalClient } from './paypal.client';

jest.mock('../core/gateway-http', () => ({
  criarHttp: jest.fn(),
  falhaDoGateway: jest.fn(),
}));

describe('PayPalClient.createOrder', () => {
  it('pede a resposta completa — é nela que vem o código do Pix', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ data: { access_token: 'tok' } })
      .mockResolvedValueOnce({ data: { id: 'ORDER-1' } });
    (criarHttp as jest.Mock).mockReturnValue({ post });

    await new PayPalClient().createOrder(
      {},
      { clientId: 'cid', clientSecret: 'sec' },
      PaymentProviderMode.SANDBOX,
      'ref-1',
    );

    // o padrão do PayPal é `return=minimal`: id, status e links, sem o
    // `payment_source.pix.qr_payload`
    const [rota, , opcoes] = post.mock.calls[1];
    expect(rota).toBe('/v2/checkout/orders');
    expect(opcoes.headers).toEqual({
      'PayPal-Request-Id': 'ref-1',
      Prefer: 'return=representation',
    });
  });
});

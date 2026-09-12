import axios from 'axios';
import { PaymentProviderMode } from '@prisma/client';
import { PagbankClient } from './pagbank.client';

jest.mock('axios');

/**
 * O cabeçalho que derrubou a reconciliação inteira.
 *
 * O `GET /charges` do PagBank responde 406 quando o Accept pede
 * `application/json`. O cliente antigo mandava o curinga; a reorganização das
 * pastas trocou pelo específico, e todo pagamento pendente passou a voltar com
 * erro de rede — sem nenhum receber baixa, e sem nada além do log denunciar.
 *
 * É um teste sobre um cabeçalho porque o estrago foi de um cabeçalho: nada no
 * tipo, no lint ou no build pega isso.
 */
describe('PagbankClient — cabeçalhos', () => {
  const create = axios.create as unknown as jest.Mock;
  let get: jest.Mock;

  beforeEach(() => {
    get = jest.fn().mockResolvedValue({ data: [] });
    create.mockReset();
    create.mockReturnValue({ get, post: jest.fn() });
  });

  const cred = { token: 'tok-de-teste' };

  const headersUsados = () => create.mock.calls[0][0].headers;

  it('pede Accept curinga, e não application/json', async () => {
    await new PagbankClient().getCharges(
      'ref-1',
      cred,
      PaymentProviderMode.PRODUCTION,
    );

    expect(headersUsados().Accept).toBe('*/*');
  });

  it('manda o token da credencial, e não o do ambiente', async () => {
    process.env.TOKEN_API_PAG_BANCK = 'token-do-env-que-nao-deve-ser-usado';

    await new PagbankClient().getCharges(
      'ref-1',
      cred,
      PaymentProviderMode.PRODUCTION,
    );

    expect(headersUsados().Authorization).toBe('Bearer tok-de-teste');
  });

  it('usa a base do modo escolhido', async () => {
    const client = new PagbankClient();

    await client.getCharges('ref-1', cred, PaymentProviderMode.SANDBOX);
    expect(create.mock.calls[0][0].baseURL).toBe(
      'https://sandbox.api.pagseguro.com',
    );

    create.mockClear();
    await client.getCharges('ref-1', cred, PaymentProviderMode.PRODUCTION);
    expect(create.mock.calls[0][0].baseURL).toBe('https://api.pagseguro.com');
  });
});

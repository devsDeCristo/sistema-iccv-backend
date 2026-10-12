import { SecretCryptoService } from 'src/crypto/secret-crypto.service';
import { PluggyService, contaDoBanco } from './pluggy.service';

/**
 * O que importa aqui é a promessa do cofre: a credencial entra cifrada, não
 * volta para a tela, e mexer só nos Item IDs não apaga o secret gravado.
 */
describe('PluggyService.salvar', () => {
  const CLIENT_ID = 'c4a6d91e-f78a-4d8b-9c1e-0a1b2c3d4e5f';
  const ITEM = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const original = { ...process.env };

  let linha: any;
  let crypto: SecretCryptoService;
  let service: PluggyService;

  beforeEach(() => {
    process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString(
      'base64',
    );
    crypto = new SecretCryptoService();
    linha = null;

    const prisma = {
      pluggyIntegration: {
        findUnique: async () => linha,
        upsert: async ({ create, update }: any) =>
          (linha = {
            churchId: 'igreja-1',
            ...(linha ?? create),
            ...update,
          }),
      },
      // a recontagem das contas pela divisão dos bancos
      financialEntry: { updateMany: async () => ({ count: 0 }) },
    };

    service = new PluggyService(prisma as any, crypto);
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('grava cifrado e devolve só a máscara', async () => {
    const tela = await service.salvar('igreja-1', {
      clientId: CLIENT_ID,
      clientSecret: 'segredo-123',
      itemIds: [ITEM],
    });

    expect(linha.credentials).not.toContain('segredo-123');
    expect(JSON.stringify(tela)).not.toContain('segredo-123');
    expect(tela).not.toHaveProperty('credentials');
    expect(tela.credentialsHint).toEqual({ clientId: '••••4e5f' });
  });

  it('secret em branco mantém o gravado', async () => {
    await service.salvar('igreja-1', {
      clientId: CLIENT_ID,
      clientSecret: 'segredo-123',
      itemIds: [ITEM],
    });

    await service.salvar('igreja-1', { itemIds: [ITEM, ITEM] });

    expect(crypto.decifrar(linha.credentials, 'pluggy:igreja-1')).toEqual({
      clientId: CLIENT_ID,
      clientSecret: 'segredo-123',
    });
    expect(linha.itemIds).toEqual([ITEM]);
  });

  it('recusa a primeira gravação sem credencial', async () => {
    await expect(
      service.salvar('igreja-1', { itemIds: [ITEM] }),
    ).rejects.toThrow('Client ID e o Client Secret');
  });

  it('o envelope não abre como credencial de outra igreja', async () => {
    await service.salvar('igreja-1', {
      clientId: CLIENT_ID,
      clientSecret: 'segredo-123',
      itemIds: [ITEM],
    });

    expect(() =>
      crypto.decifrar(linha.credentials, 'pluggy:igreja-2'),
    ).toThrow();
  });
});

describe('contaDoBanco', () => {
  const divisao = {
    splitByTreasury: true,
    itemAccounts: {
      'item-a': 'EVENTS',
      'item-b': 'CONGREGATIONS',
      'item-c': 'X',
    },
  };

  it('com a divisão, cada banco vai para a sua tesouraria', () => {
    expect(contaDoBanco(divisao, 'item-a')).toBe('EVENTS');
    expect(contaDoBanco(divisao, 'item-b')).toBe('CONGREGATIONS');
  });

  it('banco fora da divisão, valor estranho ou sem divisão: Administrativa', () => {
    expect(contaDoBanco(divisao, 'item-z')).toBe('ADMINISTRATIVE');
    expect(contaDoBanco(divisao, 'item-c')).toBe('ADMINISTRATIVE');
    expect(contaDoBanco({ ...divisao, splitByTreasury: false }, 'item-a')).toBe(
      'ADMINISTRATIVE',
    );
    expect(contaDoBanco(divisao, null)).toBe('ADMINISTRATIVE');
  });
});

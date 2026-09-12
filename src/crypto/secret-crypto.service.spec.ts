import { SecretCryptoService } from './secret-crypto.service';

/**
 * O que estes testes protegem não é o algoritmo — é a promessa que o resto do
 * sistema faz em cima dele: que a credencial de uma igreja não serve para
 * outra, e que um envelope adulterado falha em vez de devolver lixo.
 */
describe('SecretCryptoService', () => {
  const CHAVE_A = Buffer.alloc(32, 1).toString('base64');
  const CHAVE_B = Buffer.alloc(32, 2).toString('base64');

  const original = { ...process.env };

  function criar(env: Record<string, string | undefined>) {
    for (const nome of Object.keys(process.env)) {
      if (nome.startsWith('PAYMENT_CREDENTIALS_KEY')) delete process.env[nome];
    }
    Object.assign(process.env, env);
    return new SecretCryptoService();
  }

  afterEach(() => {
    for (const nome of Object.keys(process.env)) {
      if (nome.startsWith('PAYMENT_CREDENTIALS_KEY')) delete process.env[nome];
    }
    Object.assign(process.env, original);
  });

  it('abre o que ele mesmo fechou', () => {
    const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });
    const segredo = { token: 'tok-123', baseUrl: '' };

    const envelope = cofre.cifrar(segredo, 'igreja-1:PAGBANK');

    expect(envelope).not.toContain('tok-123');
    expect(cofre.decifrar(envelope, 'igreja-1:PAGBANK')).toEqual(segredo);
  });

  it('o mesmo segredo gera envelopes diferentes a cada gravação', () => {
    const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });

    const um = cofre.cifrar({ token: 'igual' }, 'igreja-1:PAGBANK');
    const outro = cofre.cifrar({ token: 'igual' }, 'igreja-1:PAGBANK');

    // IV aleatório por gravação: sem isso, duas igrejas com o mesmo token
    // teriam envelopes idênticos, e comparar as colunas denunciaria o fato.
    expect(um).not.toEqual(outro);
  });

  describe('o selo amarra o envelope ao dono', () => {
    it('recusa o envelope movido para outra igreja', () => {
      const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });
      const envelope = cofre.cifrar({ token: 'x' }, 'igreja-1:PAGBANK');

      // É o ataque de quem escreve no banco: copiar a credencial da igreja
      // vizinha para a própria linha e passar a receber o dinheiro dela.
      expect(() => cofre.decifrar(envelope, 'igreja-2:PAGBANK')).toThrow();
    });

    it('recusa o envelope movido para outra casa de pagamento', () => {
      const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });
      const envelope = cofre.cifrar({ token: 'x' }, 'igreja-1:PAGBANK');

      expect(() => cofre.decifrar(envelope, 'igreja-1:TON')).toThrow();
    });
  });

  it('recusa envelope adulterado em vez de devolver lixo', () => {
    const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });
    const envelope = cofre.cifrar({ token: 'x' }, 'igreja-1:PAGBANK');

    const partes = envelope.split('.');
    partes[3] = Buffer.from('outra coisa').toString('base64url');

    expect(() =>
      cofre.decifrar(partes.join('.'), 'igreja-1:PAGBANK'),
    ).toThrow();
  });

  it('recusa envelope de outra chave', () => {
    const antigo = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });
    const envelope = antigo.cifrar({ token: 'x' }, 'igreja-1:PAGBANK');

    const novo = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_B });

    expect(() => novo.decifrar(envelope, 'igreja-1:PAGBANK')).toThrow();
  });

  it('na rotação, a chave nova sela e a antiga ainda abre', () => {
    const antigo = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });
    const envelopeAntigo = antigo.cifrar(
      { token: 'antigo' },
      'igreja-1:PAGBANK',
    );

    const rotacionado = criar({
      PAYMENT_CREDENTIALS_KEY: CHAVE_B,
      PAYMENT_CREDENTIALS_KEY_VERSION: '2',
      PAYMENT_CREDENTIALS_KEY_V1: CHAVE_A,
    });

    // o que já estava guardado continua legível...
    expect(rotacionado.decifrar(envelopeAntigo, 'igreja-1:PAGBANK')).toEqual({
      token: 'antigo',
    });

    // ...e o que nasce agora nasce na chave nova
    const novo = rotacionado.cifrar({ token: 'novo' }, 'igreja-1:PAGBANK');
    expect(novo.startsWith('v2.')).toBe(true);
    expect(rotacionado.versaoDaChaveAtiva).toBe(2);
  });

  describe('sem chave utilizável', () => {
    it('não se declara disponível quando a chave falta', () => {
      expect(criar({}).disponivel).toBe(false);
    });

    it('recusa uma chave de tamanho errado em vez de esticá-la', () => {
      // Uma chave curta aceita "com um jeitinho" cifraria sem reclamar e com
      // uma fração da força anunciada.
      const cofre = criar({ PAYMENT_CREDENTIALS_KEY: 'curta-demais' });

      expect(cofre.disponivel).toBe(false);
      expect(() => cofre.cifrar({ a: 1 }, 'ctx')).toThrow();
    });
  });

  describe('segredo de webhook', () => {
    it('gera segredo longo e hash estável', () => {
      const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });

      const segredo = cofre.gerarSegredoDeWebhook();
      expect(segredo.length).toBeGreaterThanOrEqual(40);
      expect(cofre.gerarSegredoDeWebhook()).not.toEqual(segredo);

      // O hash precisa ser determinístico: é por ele que a rota de notificação
      // encontra a configuração.
      expect(cofre.hashDeWebhook(segredo)).toEqual(
        cofre.hashDeWebhook(segredo),
      );
      expect(cofre.hashDeWebhook(segredo)).not.toContain(segredo);
    });

    it('compara sem vazar o tamanho do acerto', () => {
      const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });

      expect(cofre.comparar('abc', 'abc')).toBe(true);
      expect(cofre.comparar('abc', 'abd')).toBe(false);
      expect(cofre.comparar('abc', 'abcd')).toBe(false);
      expect(cofre.comparar('', 'abc')).toBe(false);
    });
  });

  it('a máscara mostra o fim e esconde o resto', () => {
    const cofre = criar({ PAYMENT_CREDENTIALS_KEY: CHAVE_A });

    expect(cofre.mascarar('APP_USR-1234567890-ABCD')).toBe('••••ABCD');
    expect(cofre.mascarar('abc')).toBe('••••');
  });
});

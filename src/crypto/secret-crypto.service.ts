import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

/**
 * AES-256-GCM: cifra e autentica na mesma passagem. Modo autenticado e não
 * CBC de propósito — sem a etiqueta de autenticação, quem escreve no banco
 * consegue virar bits do texto cifrado e a abertura devolve lixo silencioso
 * em vez de erro. Aqui o lixo é recusado.
 */
const ALGORITMO = 'aes-256-gcm';

/** 96 bits é o tamanho nativo do GCM: qualquer outro força um pré-hash interno */
const TAMANHO_IV = 12;
const TAMANHO_ETIQUETA = 16;
const TAMANHO_CHAVE = 32;

/** Separador do envelope. Base64url não produz ponto, então não há ambiguidade. */
const SEPARADOR = '.';

/**
 * Guarda segredo de terceiro no banco — hoje as credenciais de cobrança.
 *
 * A diferença para o que o sistema já fazia com senha: senha é verificada, e
 * hash basta. Credencial de gateway precisa ser **usada** na chamada à API da
 * casa, então tem que voltar em claro. O que dá para fazer é garantir que ela
 * só volte para quem tem a chave — e que a chave não more no banco.
 *
 * ## O envelope
 *
 * `v<versão>.<iv>.<etiqueta>.<texto cifrado>`, tudo em base64url. A versão diz
 * qual chave selou, e é ela que permite rotacionar sem parar o sistema: a nova
 * passa a selar, a antiga continua abrindo o que já estava guardado.
 *
 * ## O selo
 *
 * Todo envelope é selado com um `contexto` — para as credenciais,
 * `churchId:provider`. O contexto entra como dado autenticado (AAD): não é
 * guardado no envelope, mas a abertura só funciona se o mesmo texto for
 * apresentado de novo.
 *
 * É o que fecha o buraco que sobraria: sem ele, quem consegue escrever no
 * banco copia o envelope da igreja A para a linha da igreja B e passa a
 * receber o dinheiro dela sem nunca ter visto a chave. Com ele, o envelope
 * copiado não abre.
 */
@Injectable()
export class SecretCryptoService {
  private readonly logger = new Logger(SecretCryptoService.name);

  /** versão → chave. Carregada uma vez: ler `process.env` a cada cifra não muda nada. */
  private readonly chaves = new Map<number, Buffer>();
  private readonly versaoAtiva: number;

  constructor() {
    this.versaoAtiva = this.lerVersaoAtiva();
    this.carregarChaves();

    if (!this.chaves.has(this.versaoAtiva)) {
      // Aviso e não exceção: sem chave o sistema sobe sem cobrar online, que é
      // o modo degradado aceitável (a igreja recebe pela mão e dá baixa no
      // painel). Derrubar o processo levaria junto inscrição, check-in e
      // quarto, que não têm nada com isso.
      this.logger.warn(
        'PAYMENT_CREDENTIALS_KEY ausente ou inválida: as credenciais de ' +
          'cobrança não podem ser lidas nem gravadas, e o pagamento online ' +
          'fica indisponível até a chave ser configurada.',
      );
    }
  }

  /** Há chave utilizável? A tela de configurações pergunta antes de abrir o formulário. */
  get disponivel(): boolean {
    return this.chaves.has(this.versaoAtiva);
  }

  /** Versão que está selando agora — vai para `PaymentProviderConfig.keyVersion` */
  get versaoDaChaveAtiva(): number {
    return this.versaoAtiva;
  }

  /**
   * Sela um objeto. O retorno vai inteiro para uma coluna de texto.
   *
   * @param contexto amarra o envelope ao dono. Ver a nota sobre o selo acima.
   */
  cifrar(valor: unknown, contexto: string): string {
    const chave = this.chaveObrigatoria(this.versaoAtiva);
    const iv = randomBytes(TAMANHO_IV);

    const cipher = createCipheriv(ALGORITMO, chave, iv, {
      authTagLength: TAMANHO_ETIQUETA,
    });
    cipher.setAAD(Buffer.from(contexto, 'utf8'));

    const cifrado = Buffer.concat([
      cipher.update(JSON.stringify(valor), 'utf8'),
      cipher.final(),
    ]);

    return [
      `v${this.versaoAtiva}`,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      cifrado.toString('base64url'),
    ].join(SEPARADOR);
  }

  /**
   * Abre um envelope. Falha — e não devolve lixo — quando a etiqueta não
   * confere: envelope adulterado, chave errada, ou contexto de outro dono.
   */
  decifrar<T = unknown>(envelope: string, contexto: string): T {
    const partes = envelope.split(SEPARADOR);

    if (partes.length !== 4 || !partes[0].startsWith('v')) {
      throw new ServiceUnavailableException(
        'Credencial gravada em formato desconhecido. Cadastre-a novamente.',
      );
    }

    const versao = Number(partes[0].slice(1));
    const chave = this.chaveObrigatoria(versao);

    try {
      const decipher = createDecipheriv(
        ALGORITMO,
        chave,
        Buffer.from(partes[1], 'base64url'),
        { authTagLength: TAMANHO_ETIQUETA },
      );
      decipher.setAAD(Buffer.from(contexto, 'utf8'));
      decipher.setAuthTag(Buffer.from(partes[2], 'base64url'));

      const aberto = Buffer.concat([
        decipher.update(Buffer.from(partes[3], 'base64url')),
        decipher.final(),
      ]);

      return JSON.parse(aberto.toString('utf8')) as T;
    } catch {
      // A mensagem não diz o que falhou. Distinguir "chave errada" de
      // "contexto errado" é contar de graça, para quem já está no banco, o
      // que ainda falta para usar o que ele copiou.
      throw new ServiceUnavailableException(
        'Não foi possível ler a credencial de cobrança desta igreja. ' +
          'Cadastre-a novamente.',
      );
    }
  }

  /**
   * Segredo aleatório para a URL de notificação. 256 bits: não há força bruta
   * que chegue nele, e é o que separa "qualquer um manda um POST dizendo que
   * foi pago" de "só a casa contratada consegue".
   */
  gerarSegredoDeWebhook(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * SHA-256 do segredo, para guardar no lugar dele.
   *
   * SHA e não bcrypt: aqui a busca é **pelo** hash — a URL chega com o segredo
   * e a rota precisa achar a configuração por chave, o que um hash com sal
   * aleatório não permite. E não faz falta: bcrypt protege segredo de baixa
   * entropia (senha), e este tem 256 bits.
   */
  hashDeWebhook(segredo: string): string {
    return createHash('sha256').update(segredo, 'utf8').digest('hex');
  }

  /** Os últimos caracteres, para a pessoa conferir a URL sem revelar o resto */
  dicaDeSegredo(segredo: string): string {
    return `…${segredo.slice(-6)}`;
  }

  /**
   * Mascara para a tela: guarda o formato e o fim, esconde o miolo. O fim, e
   * não o começo, porque prefixos de credencial (`sk_live_`, `APP_USR-`) são
   * iguais em todas as contas e não identificam nada.
   */
  mascarar(valor: string): string {
    const limpo = valor.trim();
    if (limpo.length <= 4) return '••••';
    return `••••${limpo.slice(-4)}`;
  }

  /**
   * Comparação de segredos em tempo constante.
   *
   * Um `===` vaza, pelo tempo da resposta, quantos caracteres do começo
   * bateram — e com isso um segredo se descobre caractere a caractere, sem
   * nunca precisar adivinhá-lo inteiro.
   */
  comparar(recebido: string, esperado: string): boolean {
    const a = Buffer.from(recebido ?? '', 'utf8');
    const b = Buffer.from(esperado ?? '', 'utf8');

    // O tamanho ainda escapa, e não há como escondê-lo sem custo; o que não
    // pode escapar é o conteúdo.
    if (a.length !== b.length) return false;

    return timingSafeEqual(a as any, b as any);
  }

  private chaveObrigatoria(versao: number): Buffer {
    const chave = this.chaves.get(versao);

    if (!chave) {
      throw new ServiceUnavailableException(
        `A chave de criptografia v${versao} não está configurada neste ` +
          'ambiente. O pagamento online fica indisponível até ela voltar.',
      );
    }

    return chave;
  }

  private lerVersaoAtiva(): number {
    const bruto = Number(process.env.PAYMENT_CREDENTIALS_KEY_VERSION);
    return Number.isInteger(bruto) && bruto > 0 ? bruto : 1;
  }

  /**
   * `PAYMENT_CREDENTIALS_KEY` é a chave que sela agora;
   * `PAYMENT_CREDENTIALS_KEY_V<n>` são as anteriores, que só abrem.
   *
   * Rotacionar é: colocar a atual como `_V<n>`, gerar uma nova em
   * `PAYMENT_CREDENTIALS_KEY`, subir `PAYMENT_CREDENTIALS_KEY_VERSION`. Nada
   * precisa ser reescrito no banco no mesmo momento — o envelope antigo
   * continua abrindo até ser salvo de novo.
   */
  private carregarChaves() {
    const ativa = this.decodificar(process.env.PAYMENT_CREDENTIALS_KEY);
    if (ativa) this.chaves.set(this.versaoAtiva, ativa);

    for (const [nome, valor] of Object.entries(process.env)) {
      const versao = /^PAYMENT_CREDENTIALS_KEY_V(\d+)$/.exec(nome)?.[1];
      if (!versao) continue;

      const chave = this.decodificar(valor);
      if (chave) this.chaves.set(Number(versao), chave);
    }
  }

  /**
   * Aceita base64 ou hex, e recusa qualquer coisa que não dê 32 bytes exatos.
   *
   * Recusar é o ponto: uma string curta colada por engano viraria, com um
   * `padEnd` ou um hash de conveniência, uma chave fraca que cifra sem
   * reclamar. Melhor não ter chave do que ter uma que finge.
   */
  private decodificar(valor?: string): Buffer | null {
    if (!valor?.trim()) return null;

    const limpo = valor.trim();
    const candidatos = [
      /^[0-9a-fA-F]{64}$/.test(limpo)
        ? Buffer.from(limpo, 'hex')
        : Buffer.alloc(0),
      Buffer.from(limpo, 'base64'),
    ];

    const chave = candidatos.find((buf) => buf.length === TAMANHO_CHAVE);

    if (!chave) {
      this.logger.warn(
        'Chave de criptografia ignorada: são esperados 32 bytes em base64 ' +
          '(44 caracteres) ou hex (64 caracteres).',
      );
      return null;
    }

    return chave;
  }
}

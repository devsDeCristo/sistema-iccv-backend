import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { WASocket } from 'baileys';
import { PrismaService } from 'src/prisma';
import { loadBaileys } from './baileys.loader';
import {
  churchIdsComSessao,
  clearDatabaseAuthState,
  hasStoredCredentials,
  useDatabaseAuthState,
} from './whatsapp-auth.store';

export type WhatsappStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export interface WhatsappStatusPayload {
  status: WhatsappStatus;
  /** Número pareado, quando há sessão (só dígitos, com DDI). */
  phoneNumber: string | null;
  /** Nome que o WhatsApp mostra para esse número. */
  pushName: string | null;
  /** Texto do QR a ser desenhado na tela, enquanto espera leitura. */
  qr: string | null;
  /** Código de pareamento por número, quando foi pedido. */
  pairingCode: string | null;
  connectedAt: string | null;
  /** Motivo da última queda, para a tela explicar o que aconteceu. */
  lastError: string | null;
}

export interface WhatsappGroup {
  id: string;
  name: string;
  participants: number;
}

/** Espera entre tentativas de reconexão: 5s, 10s, 20s, 40s… até 5 minutos. */
const ESPERA_INICIAL_MS = 5_000;
const ESPERA_MAXIMA_MS = 300_000;

/**
 * Pausa entre duas mensagens, sorteada a cada envio.
 *
 * Uma rajada de mensagens idênticas saindo no mesmo segundo é assinatura de
 * robô, e é assim que um número é marcado como spam. O sorteio existe para não
 * formar padrão nem no intervalo.
 */
const INTERVALO_MINIMO_MS = 8_000;
const INTERVALO_MAXIMO_MS = 25_000;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const intervaloSorteado = () =>
  INTERVALO_MINIMO_MS +
  Math.floor(Math.random() * (INTERVALO_MAXIMO_MS - INTERVALO_MINIMO_MS));

/**
 * Tira o código do link de convite do grupo. Aceita o link inteiro
 * (`https://chat.whatsapp.com/ABC123?mode=gi_t`) ou só o código.
 */
export function extraiCodigoDoConvite(link?: string | null): string | null {
  const texto = link?.trim();
  if (!texto) return null;

  const doLink = texto.match(
    /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/,
  );
  if (doLink) return doLink[1];

  // já veio só o código
  return /^[A-Za-z0-9]{15,30}$/.test(texto) ? texto : null;
}

const LIMITE_DO_DETALHE = 220;

/**
 * Formata uma linha de log vinda da biblioteca.
 *
 * O Baileys segue a convenção do pino, `log(objeto, mensagem)`, então a frase
 * legível vem por último e o objeto pode carregar o pacote binário inteiro da
 * mensagem. Aqui a frase vem primeiro e o objeto é reduzido ao que ajuda:
 * código e motivo do erro, ou um recorte curto do resto.
 */
function formataLogDoBaileys(args: unknown[]): string {
  const mensagem = args.find((arg) => typeof arg === 'string') as
    | string
    | undefined;

  const detalhes = args
    .filter((arg) => arg && typeof arg !== 'string')
    .map((arg) => {
      const alvo = (arg as any).err ?? (arg as any).error ?? arg;
      const status = alvo?.output?.statusCode;
      const motivo = alvo?.output?.payload?.message ?? alvo?.message;

      if (status || motivo) return [status, motivo].filter(Boolean).join(' ');

      const bruto = JSON.stringify(arg) ?? '';

      return bruto.length > LIMITE_DO_DETALHE
        ? `${bruto.slice(0, LIMITE_DO_DETALHE)}…`
        : bruto;
    })
    .filter(Boolean);

  return [mensagem ?? 'evento do WhatsApp', ...detalhes].join(' — ');
}

/**
 * A sessão de **uma** igreja.
 *
 * Tudo o que era campo do serviço mora aqui: socket, situação, QR, fila de
 * envio e tentativas de reconexão. A separação não é cosmética — cada igreja
 * pareia um número diferente, e um estado compartilhado faria a queda da
 * conexão de uma apagar o QR que a outra acabou de gerar.
 *
 * A fila de envio também é por igreja, e está certo assim: o que o WhatsApp
 * vigia é o ritmo de **um** número. Duas igrejas disparando ao mesmo tempo são
 * dois aparelhos diferentes conversando, não uma rajada.
 *
 * Baileys é biblioteca não oficial, que fala o mesmo protocolo do WhatsApp
 * Web. Na prática o sistema é mais um "aparelho conectado" do número, como um
 * navegador pareado. Consequências que valem lembrar:
 * - só uma instância da API pode manter uma sessão. Duas réplicas com a mesma
 *   credencial brigam pelo pareamento e derrubam uma à outra — isso continua
 *   valendo por igreja, e não deixou de valer por haver várias;
 * - o número precisa continuar existindo e ser usado como número normal. Conta
 *   nova que só dispara mensagem é o padrão que o WhatsApp bloqueia;
 * - volume alto é o que chama atenção. O uso aqui é de poucas mensagens por
 *   semana, dentro de grupos onde as pessoas entraram por vontade própria.
 */
class SessaoDaIgreja {
  private socket: WASocket | null = null;
  private status: WhatsappStatus = 'DISCONNECTED';
  private qr: string | null = null;
  private pairingCode: string | null = null;
  private connectedAt: Date | null = null;
  private lastError: string | null = null;

  /** código do convite -> JID do grupo, resolvido uma vez por processo */
  private readonly gruposPorConvite = new Map<string, string>();

  /**
   * Fila única de envio. Toda mensagem do sistema passa por aqui, venha de onde
   * vier: é o que garante que dois disparos ao mesmo tempo não virem rajada.
   */
  private filaDeEnvio: Promise<unknown> = Promise.resolve();
  private ultimoEnvioEm = 0;

  private tentativas = 0;
  private reconexao: NodeJS.Timeout | null = null;
  private encerrando = false;

  constructor(
    private readonly churchId: string,
    private readonly prisma: PrismaService,
    /** Prefixado com a igreja: com várias sessões, log sem dono não se lê. */
    private readonly logger: Logger,
  ) {}

  /** Nada mais a fazer por esta igreja: o registro pode esquecê-la. */
  get ociosa(): boolean {
    return (
      !this.socket && this.status === 'DISCONNECTED' && this.reconexao === null
    );
  }

  encerrar() {
    this.encerrando = true;
    this.cancelaReconexao();
    this.socket?.end(undefined);
  }

  /** Retoma a sessão ao subir, quando esta igreja já tem número pareado. */
  async retomar() {
    if (await hasStoredCredentials(this.prisma, this.churchId)) {
      await this.connect();
    }
  }

  getStatus(): WhatsappStatusPayload {
    const meuId = this.socket?.authState?.creds?.me?.id;

    return {
      status: this.status,
      phoneNumber: meuId ? meuId.split(':')[0].split('@')[0] : null,
      pushName: this.socket?.authState?.creds?.me?.name ?? null,
      qr: this.qr,
      pairingCode: this.pairingCode,
      connectedAt: this.connectedAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * Abre a sessão. Sem credencial gravada, o Baileys emite um QR — é o mesmo
   * fluxo de "conectar um aparelho" do WhatsApp Web.
   */
  async connect(): Promise<void> {
    if (this.socket) return;

    this.encerrando = false;
    this.status = 'CONNECTING';
    this.lastError = null;

    const { fetchLatestBaileysVersion, makeWASocket } = await loadBaileys();

    const { state, saveCreds } = await useDatabaseAuthState(
      this.prisma,
      this.churchId,
    );
    // A versão do WhatsApp Web muda com frequência; pedir a atual evita o
    // "aparelho desatualizado" que derruba a conexão.
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      logger: this.criaLogger(),
      // nome que aparece na lista de aparelhos conectados do celular
      browser: ['ICCV Eventos', 'Chrome', '1.0.0'],
      // sem isto o sistema fica "online" e o celular deixa de notificar o dono
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.socket = socket;

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', (evento) => {
      this.aoMudarConexao(socket, evento).catch((erro) =>
        this.logger.error(`Erro tratando connection.update: ${erro.message}`),
      );
    });
  }

  /**
   * Alternativa ao QR: o admin informa o número e digita no celular o código
   * de 8 caracteres que volta daqui.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    const numero = phoneNumber.replace(/\D/g, '');

    if (numero.length < 12) {
      throw new ServiceUnavailableException(
        'Informe o número com DDI e DDD, por exemplo 5544999999999.',
      );
    }

    if (this.status === 'CONNECTED') {
      throw new ServiceUnavailableException('Já existe um número conectado.');
    }

    if (!this.socket) await this.connect();

    // O Baileys só aceita o pedido depois que o socket terminou de subir.
    for (let i = 0; i < 20 && !this.qr; i++) await espera(500);

    const codigo = await this.socket.requestPairingCode(numero);

    this.pairingCode = codigo;

    return codigo;
  }

  /**
   * Desiste do pareamento em andamento.
   *
   * O QR fica no ar esperando alguém ler, e sem isto não haveria como voltar
   * atrás: a tela seguiria "aguardando pareamento" para sempre, e o serviço
   * continuaria gerando QR atrás de ninguém.
   *
   * As credenciais parciais que o Baileys já gravou são apagadas — sem o
   * pareamento concluído elas não valem nada e ainda fariam a API tentar
   * reconectar sozinha no próximo start. Número já pareado não é tocado: se a
   * queda foi de rede, cancelar aqui só encerra as tentativas, e "Conectar"
   * traz a sessão de volta sem novo QR.
   */
  async cancelPairing(): Promise<void> {
    this.encerrando = true;
    this.cancelaReconexao();

    const jaPareado = !!this.socket?.authState?.creds?.registered;

    this.socket?.end(undefined);
    this.socket = null;

    if (!jaPareado) await clearDatabaseAuthState(this.prisma, this.churchId);

    this.status = 'DISCONNECTED';
    this.qr = null;
    this.pairingCode = null;
    this.tentativas = 0;
    this.lastError = null;

    this.logger.log(
      jaPareado
        ? 'Tentativas de reconexão canceladas pelo admin'
        : 'Pareamento cancelado pelo admin',
    );
  }

  /** Desconecta o número e apaga a sessão: o próximo uso pede pareamento de novo. */
  async disconnect(): Promise<void> {
    this.encerrando = true;
    this.cancelaReconexao();

    // O logout é a mensagem que tira o sistema da lista de aparelhos do celular
    // — só faz sentido com a sessão de pé. Fora disso, é esperar o tempo de uma
    // chamada que vai falhar de qualquer jeito.
    if (this.status === 'CONNECTED') {
      try {
        await this.socket?.logout();
      } catch (erro) {
        // Sessão já morta do outro lado: seguir e limpar do mesmo jeito.
        this.logger.warn(`Logout não completou: ${erro.message}`);
      }
    }

    this.socket?.end(undefined);
    this.socket = null;

    await clearDatabaseAuthState(this.prisma, this.churchId);

    this.status = 'DISCONNECTED';
    this.qr = null;
    this.pairingCode = null;
    this.connectedAt = null;
    this.tentativas = 0;
  }

  /**
   * Converte o link de convite do grupo (`chat.whatsapp.com/CODIGO`) no JID
   * (`...@g.us`), que é o endereço que o envio exige — o convite serve para
   * entrar no grupo, não para escrever nele.
   *
   * O resultado fica em memória porque o JID de um grupo não muda enquanto ele
   * existir; redefinir o link no WhatsApp não cria outro grupo.
   */
  async resolveGroupIdFromInvite(link: string): Promise<string> {
    const codigo = extraiCodigoDoConvite(link);

    if (!codigo) {
      throw new ServiceUnavailableException(
        `Link de grupo inválido: "${link}"`,
      );
    }

    const emCache = this.gruposPorConvite.get(codigo);
    if (emCache) return emCache;

    const socket = this.exigeConexao();
    const dados = await socket.groupGetInviteInfo(codigo);

    if (!dados?.id) {
      throw new ServiceUnavailableException(
        'Não foi possível identificar o grupo por este link.',
      );
    }

    this.gruposPorConvite.set(codigo, dados.id);

    return dados.id;
  }

  /** Grupos em que o número conectado participa. */
  async listGroups(): Promise<WhatsappGroup[]> {
    const socket = this.exigeConexao();
    const grupos = await socket.groupFetchAllParticipating();

    return Object.values(grupos)
      .map((grupo) => ({
        id: grupo.id,
        name: grupo.subject,
        participants: grupo.participants?.length ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  /**
   * Envia para um grupo. Com `imageUrl` a mensagem sai como imagem legendada,
   * que é como uma notícia com foto aparece melhor no aplicativo.
   *
   * Toda mensagem passa pela fila: nada sai em paralelo, e entre uma e outra
   * há uma pausa sorteada. Como a fila é do serviço, dois disparos disparados
   * ao mesmo tempo se intercalam nela em vez de saírem juntos.
   */
  async sendToGroup(groupId: string, text: string, imageUrl?: string | null) {
    return this.enfileira(async () => {
      // Conferido antes da espera: com o número desconectado não faz sentido
      // segurar quem chamou por 20 segundos para depois recusar.
      const socket = this.exigeConexao();

      await this.respeitaIntervalo();

      if (imageUrl) {
        await socket.sendMessage(groupId, {
          image: { url: imageUrl },
          caption: text,
        });
      } else {
        await socket.sendMessage(groupId, { text });
      }

      this.ultimoEnvioEm = Date.now();
    });
  }

  /**
   * Encadeia a tarefa no fim da fila. O `catch` mantém a corrente viva: uma
   * mensagem que falha não pode travar as seguintes.
   */
  private enfileira<T>(tarefa: () => Promise<T>): Promise<T> {
    const resultado = this.filaDeEnvio.then(tarefa, tarefa);

    this.filaDeEnvio = resultado.then(
      () => undefined,
      () => undefined,
    );

    return resultado;
  }

  /**
   * Segura a mensagem até completar o intervalo desde a última que saiu. Se já
   * passou tempo suficiente — o caso comum, avisos esparsos no dia —, não
   * espera nada.
   */
  private async respeitaIntervalo() {
    if (!this.ultimoEnvioEm) return;

    const desdeAUltima = Date.now() - this.ultimoEnvioEm;
    const restante = intervaloSorteado() - desdeAUltima;

    if (restante > 0) await espera(restante);
  }

  private exigeConexao(): WASocket {
    if (!this.socket || this.status !== 'CONNECTED') {
      throw new ServiceUnavailableException(
        'WhatsApp desconectado. Conecte o número desta igreja em Configurações > Disparadores.',
      );
    }

    return this.socket;
  }

  private async aoMudarConexao(
    origem: WASocket,
    evento: {
      connection?: string;
      lastDisconnect?: { error?: Error };
      qr?: string;
    },
  ) {
    // Um socket descartado ainda avisa o próprio fechamento, e esse aviso chega
    // depois de o seguinte já estar de pé: cancelar o pareamento e pedir um QR
    // novo cairia aqui como "conexão perdida", apagando o QR recém-criado.
    if (this.socket !== origem) return;

    const { connection, lastDisconnect, qr } = evento;

    if (qr) {
      this.qr = qr;
      this.status = 'CONNECTING';
    }

    if (connection === 'open') {
      this.status = 'CONNECTED';
      this.qr = null;
      this.pairingCode = null;
      this.connectedAt = new Date();
      this.lastError = null;
      this.tentativas = 0;
      this.logger.log('WhatsApp conectado');
    }

    if (connection === 'close') {
      const { DisconnectReason } = await loadBaileys();
      const codigo = (lastDisconnect?.error as any)?.output?.statusCode;

      this.socket = null;
      this.qr = null;

      // Sessão encerrada do lado do WhatsApp (o dono removeu o aparelho, ou a
      // credencial não vale mais): reconectar só repetiria o erro, o caminho é
      // parear de novo.
      const naoAdiantaTentar =
        codigo === DisconnectReason.loggedOut ||
        codigo === DisconnectReason.badSession;

      if (naoAdiantaTentar) {
        await clearDatabaseAuthState(this.prisma, this.churchId);
        this.status = 'DISCONNECTED';
        this.lastError =
          'Sessão encerrada no WhatsApp. Pareie o número novamente.';
        this.logger.warn(this.lastError);
        return;
      }

      if (this.encerrando) {
        this.status = 'DISCONNECTED';
        return;
      }

      this.status = 'CONNECTING';
      this.lastError = lastDisconnect?.error?.message ?? 'Conexão perdida';
      this.agendaReconexao();
    }
  }

  private agendaReconexao() {
    this.cancelaReconexao();

    const atraso = Math.min(
      ESPERA_INICIAL_MS * 2 ** this.tentativas,
      ESPERA_MAXIMA_MS,
    );

    this.tentativas += 1;
    this.logger.warn(
      `WhatsApp caiu (${this.lastError}). Nova tentativa em ${atraso / 1000}s.`,
    );

    this.reconexao = setTimeout(() => {
      this.connect().catch((erro) => {
        this.lastError = erro.message;
        this.agendaReconexao();
      });
    }, atraso);
  }

  private cancelaReconexao() {
    if (this.reconexao) {
      clearTimeout(this.reconexao);
      this.reconexao = null;
    }
  }

  /**
   * O Baileys espera um logger no formato do pino. Em vez de trazer o pino como
   * dependência só para isso, um objeto mínimo dá conta — e joga fora o `trace`
   * e o `debug`, que numa sessão ativa saem às centenas por minuto.
   */
  private criaLogger() {
    const noop = () => undefined;
    const logger: any = {
      level: 'warn',
      child: () => logger,
      trace: noop,
      debug: noop,
      info: noop,
      warn: (...args: unknown[]) => this.logger.warn(formataLogDoBaileys(args)),
      // O que a biblioteca chama de `error` são quase sempre percalços de
      // protocolo que ela mesma contorna: mensagem que não decifrou, consulta
      // interna que estourou o tempo. Nada disso derruba a sessão, e quem
      // avisa de queda de verdade é o `connection.update` mais acima — então
      // aqui vira aviso, para não soar alarme por ruído de rotina.
      error: (...args: unknown[]) =>
        this.logger.warn(formataLogDoBaileys(args)),
      fatal: (...args: unknown[]) =>
        this.logger.error(formataLogDoBaileys(args)),
    };

    return logger;
  }
}

/** O que a tela vê de uma igreja que nunca pareou número nenhum. */
const SEM_SESSAO: WhatsappStatusPayload = {
  status: 'DISCONNECTED',
  phoneNumber: null,
  pushName: null,
  qr: null,
  pairingCode: null,
  connectedAt: null,
  lastError: null,
};

/**
 * O disparador de WhatsApp do sistema: uma sessão por igreja.
 *
 * Este serviço não conversa com o WhatsApp — ele guarda as sessões e entrega a
 * certa para quem pede. Toda a conversa mora em `SessaoDaIgreja`, e a razão de
 * existirem duas classes é que antes havia uma só e ela acumulava as duas
 * coisas: enquanto a sessão era única no processo, "o serviço" e "a sessão"
 * eram a mesma entidade e ninguém sentia falta da separação. Com um número por
 * igreja, misturá-las voltaria a significar estado de uma vazando na outra.
 *
 * Nenhum método existe sem `churchId`. É a mesma decisão do
 * `whatsapp-auth.store`, e pelo mesmo motivo: um disparo que esquecesse a
 * igreja sairia pelo número da primeira que estivesse conectada, e o inscrito
 * receberia o aviso de uma igreja pelo telefone de outra.
 */
@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);

  /** igreja -> sessão. Só existe entrada para quem já pediu conexão. */
  private readonly sessoes = new Map<string, SessaoDaIgreja>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retoma, ao subir, as sessões das igrejas que já têm número pareado.
   *
   * Em paralelo e com o erro contido em cada uma: uma credencial estragada não
   * pode impedir as outras igrejas de voltarem ao ar, e `Promise.all` com uma
   * rejeição faria exatamente isso.
   */
  async onModuleInit() {
    const igrejas = await churchIdsComSessao(this.prisma);

    if (igrejas.length === 0) return;

    this.logger.log(
      `Retomando ${igrejas.length} sessão(ões) de WhatsApp ao subir`,
    );

    await Promise.all(
      igrejas.map((churchId) =>
        this.sessao(churchId)
          .retomar()
          .catch((erro) =>
            this.logger.error(
              `Falha ao retomar a sessão da igreja ${churchId}: ${erro.message}`,
            ),
          ),
      ),
    );
  }

  async onModuleDestroy() {
    for (const sessao of this.sessoes.values()) sessao.encerrar();
  }

  /**
   * Situação da sessão desta igreja.
   *
   * Não cria sessão: consultar a tela de uma igreja que nunca pareou nada não
   * pode abrir conexão nenhuma — a consulta roda em intervalo curto enquanto a
   * tela está aberta, e criar aqui deixaria um socket de pé para cada igreja
   * que alguém abriu por curiosidade.
   */
  getStatus(churchId: string): WhatsappStatusPayload {
    return this.sessoes.get(churchId)?.getStatus() ?? SEM_SESSAO;
  }

  async connect(churchId: string): Promise<WhatsappStatusPayload> {
    const sessao = this.sessao(churchId);
    await sessao.connect();
    return sessao.getStatus();
  }

  async requestPairingCode(churchId: string, phoneNumber: string) {
    return this.sessao(churchId).requestPairingCode(phoneNumber);
  }

  async cancelPairing(churchId: string): Promise<WhatsappStatusPayload> {
    const sessao = this.sessoes.get(churchId);
    if (!sessao) return SEM_SESSAO;

    await sessao.cancelPairing();
    this.descartaSeOciosa(churchId, sessao);

    return sessao.getStatus();
  }

  async disconnect(churchId: string): Promise<WhatsappStatusPayload> {
    const sessao = this.sessoes.get(churchId);

    // Sem sessão viva ainda pode haver credencial gravada — de um processo
    // anterior que não chegou a reconectar. Desconectar precisa limpá-la do
    // mesmo jeito, senão o próximo start reabre o que o admin mandou fechar.
    if (!sessao) {
      await clearDatabaseAuthState(this.prisma, churchId);
      return SEM_SESSAO;
    }

    await sessao.disconnect();
    this.descartaSeOciosa(churchId, sessao);

    return sessao.getStatus();
  }

  listGroups(churchId: string): Promise<WhatsappGroup[]> {
    return this.exigeSessao(churchId).listGroups();
  }

  resolveGroupIdFromInvite(churchId: string, link: string): Promise<string> {
    return this.exigeSessao(churchId).resolveGroupIdFromInvite(link);
  }

  sendToGroup(
    churchId: string,
    groupId: string,
    text: string,
    imageUrl?: string | null,
  ) {
    return this.exigeSessao(churchId).sendToGroup(groupId, text, imageUrl);
  }

  /** A sessão da igreja, criada na primeira vez que alguém precisa dela. */
  private sessao(churchId: string): SessaoDaIgreja {
    const existente = this.sessoes.get(churchId);
    if (existente) return existente;

    const nova = new SessaoDaIgreja(
      churchId,
      this.prisma,
      new Logger(`${WhatsappService.name}[${churchId}]`),
    );

    this.sessoes.set(churchId, nova);

    return nova;
  }

  /**
   * Para quem vai **usar** a conexão, e não configurá-la.
   *
   * Recusa sem criar sessão: uma notícia publicada por uma igreja que nunca
   * pareou número precisa falhar com a explicação, e não abrir uma conexão
   * silenciosamente para descobrir, 20 segundos depois, que não há credencial.
   */
  private exigeSessao(churchId: string): SessaoDaIgreja {
    const sessao = this.sessoes.get(churchId);

    if (!sessao) {
      throw new ServiceUnavailableException(
        'Esta igreja ainda não conectou um número de WhatsApp. ' +
          'Configurações > Disparadores.',
      );
    }

    return sessao;
  }

  /** Sessão desconectada e sem reconexão agendada não precisa ocupar memória */
  private descartaSeOciosa(churchId: string, sessao: SessaoDaIgreja) {
    if (sessao.ociosa) this.sessoes.delete(churchId);
  }
}

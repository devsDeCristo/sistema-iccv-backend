import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PluggyIntegration } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SecretCryptoService } from 'src/crypto/secret-crypto.service';
import { criarHttp } from 'src/gateways/core/gateway-http';
import { SavePluggyDto } from './dto/save-pluggy.dto';

const BASE = 'https://api.pluggy.ai';

/** Situações do item na Pluggy em que os dados do banco estão chegando */
const ITEM_OK = ['UPDATED', 'UPDATING'];

interface Credenciais {
  clientId: string;
  clientSecret: string;
}

/** Amarra o envelope à igreja: copiado para a linha de outra, não abre */
const selo = (churchId: string) => `pluggy:${churchId}`;

/**
 * A credencial da Pluggy de cada igreja, para o módulo financeiro.
 *
 * Só guarda e testa. A leitura de contas e extratos entra quando o escopo do
 * financeiro estiver fechado, e parte daqui (`abrir` + `apiKey`).
 */
@Injectable()
export class PluggyService {
  private readonly logger = new Logger(PluggyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
  ) {}

  async buscar(churchId: string) {
    const integracao = await this.prisma.pluggyIntegration.findUnique({
      where: { churchId },
    });

    return {
      cofreDisponivel: this.crypto.disponivel,
      integracao: integracao ? this.paraTela(integracao) : null,
    };
  }

  /**
   * Cria ou atualiza. Client ID ou Secret em branco mantém o gravado, como em
   * `PaymentProviderService`: mexer nos Item IDs não pode obrigar a redigitar
   * o secret.
   */
  async salvar(churchId: string, dto: SavePluggyDto, actorId?: string) {
    this.exigirCofre();

    const existente = await this.prisma.pluggyIntegration.findUnique({
      where: { churchId },
    });

    const clientId = dto.clientId?.trim();
    const clientSecret = dto.clientSecret?.trim();
    const atuais =
      existente && (!clientId || !clientSecret)
        ? this.abrirCofre(existente)
        : null;

    const credenciais: Credenciais = {
      clientId: clientId || atuais?.clientId,
      clientSecret: clientSecret || atuais?.clientSecret,
    };

    if (!credenciais.clientId || !credenciais.clientSecret) {
      throw new BadRequestException(
        'Informe o Client ID e o Client Secret da aplicação na Pluggy',
      );
    }

    const dados = {
      credentials: this.crypto.cifrar(credenciais, selo(churchId)),
      keyVersion: this.crypto.versaoDaChaveAtiva,
      credentialsHint: { clientId: this.crypto.mascarar(credenciais.clientId) },
      itemIds: [...new Set(dto.itemIds)],
      enabled: dto.enabled ?? existente?.enabled ?? true,
      updatedById: actorId ?? null,
    };

    const salvo = await this.prisma.pluggyIntegration.upsert({
      where: { churchId },
      create: { churchId, createdById: actorId ?? null, ...dados },
      update: dados,
    });

    return this.paraTela(salvo);
  }

  async remover(churchId: string) {
    await this.exigir(churchId);
    await this.prisma.pluggyIntegration.delete({ where: { churchId } });
  }

  /**
   * Autentica e consulta cada Item ID: de qual banco é, em que situação está
   * e quantas contas traz. Não grava nada.
   *
   * Credencial recusada volta como resultado, e não como erro: é a resposta
   * que o teste existe para dar.
   */
  async testar(churchId: string) {
    const { credenciais, integracao } = await this.abrir(churchId);

    let apiKey: string;
    try {
      apiKey = await this.apiKey(credenciais);
    } catch (err: any) {
      this.logger.warn(
        `Pluggy recusou a credencial da igreja ${churchId}: ${
          err?.response?.status ?? err?.message
        }`,
      );
      return {
        ok: false,
        erro: 'A Pluggy recusou o Client ID e o Client Secret. Confira no dashboard da Pluggy.',
        itens: [],
      };
    }

    const http = criarHttp(BASE, { headers: { 'X-API-KEY': apiKey } });

    const itens = await Promise.all(
      integracao.itemIds.map(async (itemId) => {
        try {
          const [{ data: item }, { data: contas }] = await Promise.all([
            http.get(`/items/${itemId}`),
            http.get('/accounts', { params: { itemId } }),
          ]);

          return {
            itemId,
            ok: ITEM_OK.includes(item.status),
            banco: item.connector?.name ?? null,
            status: item.status as string,
            contas: (contas.results ?? []).length,
            atualizadoEm: item.lastUpdatedAt ?? null,
          };
        } catch (err: any) {
          return {
            itemId,
            ok: false,
            erro:
              err?.response?.status === 404
                ? 'Item ID não encontrado nesta aplicação da Pluggy'
                : 'Não foi possível consultar este item',
          };
        }
      }),
    );

    return { ok: itens.length > 0 && itens.every((i) => i.ok), itens };
  }

  /** A chave de acesso da API. Vale 2h na Pluggy; ainda sem cache, porque só o teste a usa. */
  async apiKey(credenciais: Credenciais): Promise<string> {
    const { data } = await criarHttp(BASE).post('/auth', credenciais);
    return data.apiKey;
  }

  /** A integração da igreja com a credencial aberta. Só em memória, no servidor. */
  async abrir(churchId: string) {
    this.exigirCofre();
    const integracao = await this.exigir(churchId);
    return { integracao, credenciais: this.abrirCofre(integracao) };
  }

  // ----------------------------------------------------------------------

  private async exigir(churchId: string) {
    const integracao = await this.prisma.pluggyIntegration.findUnique({
      where: { churchId },
    });

    if (!integracao) {
      throw new NotFoundException('Pluggy não configurada nesta igreja');
    }

    return integracao;
  }

  private abrirCofre(integracao: PluggyIntegration): Credenciais {
    return this.crypto.decifrar<Credenciais>(
      integracao.credentials,
      selo(integracao.churchId),
    );
  }

  private exigirCofre() {
    if (!this.crypto.disponivel) {
      throw new ServiceUnavailableException(
        'A chave de criptografia de credenciais não está configurada neste ' +
          'ambiente (PAYMENT_CREDENTIALS_KEY). Fale com o suporte técnico.',
      );
    }
  }

  /** `credentials` fica de fora por construção: nem o envelope cifrado sai daqui */
  private paraTela(integracao: PluggyIntegration) {
    return {
      enabled: integracao.enabled,
      credentialsHint: integracao.credentialsHint,
      itemIds: integracao.itemIds,
      statusMessage: integracao.statusMessage,
      lastSyncAt: integracao.lastSyncAt,
      updatedAt: integracao.updatedAt,
    };
  }
}

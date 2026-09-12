import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PaymentProvider,
  PaymentProviderConfig,
  PaymentProviderMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SecretCryptoService } from 'src/crypto/secret-crypto.service';
import {
  CHAVE_DO_WEBHOOK,
  contextoDoSelo,
  PaymentGatewayRegistry,
} from 'src/gateways/core/payment-gateway.registry';
import { CredentialField } from 'src/gateways/core/gateway.types';
import { montarUrlDeWebhook } from 'src/gateways/core/webhook-url';
import { UpsertPaymentProviderDto } from './dto/upsert-payment-provider.dto';

/** Teto por campo. Nenhuma credencial de gateway chega perto disso. */
const TAMANHO_MAXIMO = 2000;

@Injectable()
export class PaymentProviderService {
  private readonly logger = new Logger(PaymentProviderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentGatewayRegistry,
    private readonly crypto: SecretCryptoService,
  ) {}

  /**
   * O catálogo de integrações: o que existe e quais campos cada uma pede.
   *
   * Sai do adapter e não de uma lista na tela — é o que faz uma casa nova
   * aparecer no formulário sem ninguém mexer no front.
   */
  catalogo() {
    return {
      /**
       * Sem chave de criptografia configurada não há como guardar credencial.
       * A tela precisa saber disso para explicar, em vez de deixar a pessoa
       * preencher o formulário e levar erro no salvar.
       */
      cofreDisponivel: this.crypto.disponivel,
      providers: this.registry.descriptors(),
    };
  }

  /**
   * O que esta igreja tem configurado, junto do catálogo.
   *
   * Devolve as URLs de notificação prontas para copiar. Credencial secreta
   * nunca volta: o que a tela recebe é a máscara (`••••4F2A`), o bastante para
   * reconhecer o que está lá e insuficiente para usar em qualquer lugar.
   */
  async listar(churchId: string) {
    const configs = await this.prisma.paymentProviderConfig.findMany({
      where: { churchId },
    });

    const porProvider = new Map(configs.map((c) => [c.provider, c]));

    const integracoes = this.registry.descriptors().map((descriptor) => {
      const config = porProvider.get(descriptor.provider);

      return {
        ...descriptor,
        configured: !!config,
        enabled: config?.enabled ?? false,
        isDefault: config?.isDefault ?? false,
        mode: config?.mode ?? PaymentProviderMode.PRODUCTION,
        credentialsHint: config?.credentialsHint ?? null,
        lastWebhookAt: config?.lastWebhookAt ?? null,
        updatedAt: config?.updatedAt ?? null,
        webhooks: config ? this.urlsDeWebhook(config) : [],
      };
    });

    return { cofreDisponivel: this.crypto.disponivel, integracoes };
  }

  /**
   * Cria ou atualiza a credencial de uma casa nesta igreja.
   *
   * Duas decisões que valem comentário:
   *
   * - **Campo secreto vazio mantém o que está gravado.** Sem isso, trocar o
   *   ambiente de sandbox para produção obrigaria a redigitar o token inteiro,
   *   e o caminho fácil viraria anotar o token num bloco de notas.
   * - **O segredo do webhook é preservado entre edições.** Ele está cadastrado
   *   do lado da casa; regerá-lo a cada salvar faria toda notificação passar a
   *   cair numa URL que não existe mais, e o pagamento entraria sem ninguém
   *   ficar sabendo. Para trocá-lo existe uma rota própria.
   */
  async salvar(
    churchId: string,
    provider: PaymentProvider,
    dto: UpsertPaymentProviderDto,
    actorId?: string,
  ) {
    this.exigirCofre();

    const descriptor = this.registry.descriptor(provider);
    const existente = await this.buscar(churchId, provider);

    const atuais = existente ? this.abrirCofre(existente) : {};

    const credenciais = this.validarCampos(
      descriptor.fields,
      dto.credentials ?? {},
      atuais,
    );

    // Preserva o segredo já cadastrado do outro lado; só nasce um novo quando
    // a configuração também é nova.
    credenciais[CHAVE_DO_WEBHOOK] =
      atuais[CHAVE_DO_WEBHOOK] || this.crypto.gerarSegredoDeWebhook();

    const envelope = this.crypto.cifrar(
      credenciais,
      contextoDoSelo(churchId, provider),
    );

    const mode = dto.mode ?? existente?.mode ?? PaymentProviderMode.PRODUCTION;
    const enabled = dto.enabled ?? existente?.enabled ?? false;

    const dados = {
      mode,
      enabled,
      credentials: envelope,
      keyVersion: this.crypto.versaoDaChaveAtiva,
      credentialsHint: this.dicas(descriptor.fields, credenciais),
      webhookSecretHash: this.crypto.hashDeWebhook(
        credenciais[CHAVE_DO_WEBHOOK],
      ),
      webhookSecretHint: this.crypto.dicaDeSegredo(
        credenciais[CHAVE_DO_WEBHOOK],
      ),
      updatedById: actorId ?? null,
    };

    const config = await this.prisma.$transaction(async (tx) => {
      const salvo = await tx.paymentProviderConfig.upsert({
        where: { churchId_provider: { churchId, provider } },
        create: {
          churchId,
          provider,
          createdById: actorId ?? null,
          ...dados,
        },
        update: dados,
      });

      // Desligar a casa que era a padrão não pode deixar a igreja com um
      // padrão desligado: o checkout resolveria para ela e falharia.
      const viraPadrao = dto.makeDefault ?? (salvo.isDefault && enabled);

      return this.ajustarPadrao(tx, churchId, provider, viraPadrao && enabled);
    });

    return this.paraTela(config);
  }

  /** Torna esta a casa que recebe os novos checkouts da igreja. */
  async definirPadrao(churchId: string, provider: PaymentProvider) {
    const config = await this.exigir(churchId, provider);

    if (!config.enabled) {
      throw new BadRequestException(
        'Ligue a integração antes de torná-la a forma de pagamento padrão.',
      );
    }

    const atualizado = await this.prisma.$transaction((tx) =>
      this.ajustarPadrao(tx, churchId, provider, true),
    );

    return this.paraTela(atualizado);
  }

  /**
   * Gera um segredo novo para a URL de notificação.
   *
   * É o "revogar" desta integração: a URL antiga para de ser aceita no mesmo
   * instante. Por isso a resposta traz as URLs novas em destaque — entre a
   * troca aqui e o recadastro no painel da casa, nenhuma notificação entra, e
   * quem roda isso precisa saber que o relógio começou a correr.
   */
  async rotacionarSegredo(
    churchId: string,
    provider: PaymentProvider,
    actorId?: string,
  ) {
    this.exigirCofre();

    const config = await this.exigir(churchId, provider);
    const cofre = this.abrirCofre(config);

    cofre[CHAVE_DO_WEBHOOK] = this.crypto.gerarSegredoDeWebhook();

    const atualizado = await this.prisma.paymentProviderConfig.update({
      where: { id: config.id },
      data: {
        credentials: this.crypto.cifrar(
          cofre,
          contextoDoSelo(churchId, provider),
        ),
        keyVersion: this.crypto.versaoDaChaveAtiva,
        webhookSecretHash: this.crypto.hashDeWebhook(cofre[CHAVE_DO_WEBHOOK]),
        webhookSecretHint: this.crypto.dicaDeSegredo(cofre[CHAVE_DO_WEBHOOK]),
        updatedById: actorId ?? null,
      },
    });

    this.logger.warn(
      `Segredo de webhook rotacionado: igreja=${churchId} casa=${provider}. ` +
        'As URLs antigas deixaram de ser aceitas.',
    );

    return this.paraTela(atualizado);
  }

  /**
   * Remove a credencial.
   *
   * Recusa enquanto houver checkout ativo gerado por ela: sem a credencial não
   * há como perguntar o status nem receber o retorno, e o inscrito que já está
   * com o link aberto pagaria para um pagamento que nunca receberia baixa.
   */
  async remover(churchId: string, provider: PaymentProvider) {
    const config = await this.exigir(churchId, provider);

    const emAberto = await this.prisma.paymentCheckout.count({
      where: { configId: config.id, status: 'ACTIVE' },
    });

    if (emAberto > 0) {
      throw new BadRequestException(
        `Há ${emAberto} cobrança(s) em aberto nesta integração. Desligue-a e ` +
          'aguarde os links expirarem antes de remover a credencial.',
      );
    }

    await this.prisma.paymentProviderConfig.delete({
      where: { id: config.id },
    });
  }

  /** Bate na casa com a credencial gravada e conta o que aconteceu. */
  async testar(churchId: string, provider: PaymentProvider) {
    this.exigirCofre();
    await this.exigir(churchId, provider);

    const resolvido = await this.registry.porIgrejaEProvider(
      churchId,
      provider,
    );

    if (!resolvido) {
      throw new NotFoundException('Integração não configurada nesta igreja');
    }

    return resolvido.gateway.healthCheck(resolvido.context);
  }

  // ----------------------------------------------------------------------

  /**
   * Um padrão por igreja, trocado em transação.
   *
   * Fora de transação existe uma janela em que duas casas são a padrão ao
   * mesmo tempo — e `paraIgreja` usa `findFirst`, então o checkout daquele
   * instante sairia na casa sorteada pelo banco.
   */
  private async ajustarPadrao(
    tx: Prisma.TransactionClient,
    churchId: string,
    provider: PaymentProvider,
    viraPadrao: boolean,
  ): Promise<PaymentProviderConfig> {
    if (viraPadrao) {
      await tx.paymentProviderConfig.updateMany({
        where: { churchId, provider: { not: provider } },
        data: { isDefault: false },
      });
    }

    return tx.paymentProviderConfig.update({
      where: { churchId_provider: { churchId, provider } },
      data: { isDefault: viraPadrao },
    });
  }

  /**
   * Confere o que veio do formulário contra o que o adapter declarou.
   *
   * Lista branca, e não lista negra: campo que o descriptor não declara é
   * recusado. É o que impede alguém de mandar `__webhook` pelo formulário e
   * escolher o próprio segredo de notificação.
   */
  private validarCampos(
    campos: CredentialField[],
    enviados: Record<string, unknown>,
    atuais: Record<string, string>,
  ): Record<string, string> {
    const conhecidos = new Set(campos.map((campo) => campo.key));
    const intrusos = Object.keys(enviados).filter((k) => !conhecidos.has(k));

    if (intrusos.length) {
      throw new BadRequestException(
        `Campos não reconhecidos por esta integração: ${intrusos.join(', ')}`,
      );
    }

    const resultado: Record<string, string> = {};

    for (const campo of campos) {
      const bruto = enviados[campo.key];

      if (bruto !== undefined && bruto !== null && typeof bruto !== 'string') {
        throw new BadRequestException(`${campo.label} precisa ser um texto`);
      }

      const valor = typeof bruto === 'string' ? bruto.trim() : '';

      // Segredo em branco = "não mexi neste campo"
      if (!valor && campo.secret && atuais[campo.key]) {
        resultado[campo.key] = atuais[campo.key];
        continue;
      }

      if (!valor) {
        if (campo.required) {
          throw new BadRequestException(`${campo.label} é obrigatório`);
        }
        continue;
      }

      if (valor.length > TAMANHO_MAXIMO) {
        throw new BadRequestException(`${campo.label} é longo demais`);
      }

      if (campo.allowedHostSuffixes) {
        this.validarUrl(campo, valor);
      }

      resultado[campo.key] = valor;
    }

    return resultado;
  }

  /**
   * URL de API só aponta para a própria casa, e só por HTTPS.
   *
   * Sem esta conferência o campo vira uma alavanca: aponta-se a integração
   * para um endereço qualquer e o servidor passa a mandar a credencial da
   * igreja — e requisições autenticadas saindo de dentro da rede — para onde
   * quem preencheu mandar.
   */
  private validarUrl(campo: CredentialField, valor: string) {
    let url: URL;

    try {
      url = new URL(valor);
    } catch {
      throw new BadRequestException(`${campo.label} não é uma URL válida`);
    }

    if (url.protocol !== 'https:') {
      throw new BadRequestException(`${campo.label} precisa começar com https`);
    }

    const host = url.hostname.toLowerCase();
    const permitido = campo.allowedHostSuffixes!.some(
      (sufixo) => host === sufixo || host.endsWith(`.${sufixo}`),
    );

    if (!permitido) {
      throw new BadRequestException(
        `${
          campo.label
        } precisa ser um endereço de ${campo.allowedHostSuffixes!.join(
          ' ou ',
        )}`,
      );
    }
  }

  /**
   * O que a tela mostra no lugar do valor.
   *
   * Campo secreto vira máscara; campo aberto (um apelido, uma URL) volta
   * inteiro — esconder o que já é público só atrapalha quem está conferindo
   * se cadastrou o certo.
   */
  private dicas(
    campos: CredentialField[],
    credenciais: Record<string, string>,
  ): Prisma.InputJsonValue {
    const dicas: Record<string, string> = {};

    for (const campo of campos) {
      const valor = credenciais[campo.key];
      if (!valor) continue;

      dicas[campo.key] = campo.secret ? this.crypto.mascarar(valor) : valor;
    }

    return dicas;
  }

  private urlsDeWebhook(config: PaymentProviderConfig) {
    const descriptor = this.registry.descriptor(config.provider);

    let segredo: string;
    try {
      segredo = this.registry.segredoDeWebhook(config);
    } catch {
      // Credencial gravada com uma chave que este ambiente não tem. A tela
      // mostra a integração como configurada e sem URL, que é a verdade — e o
      // erro aparece inteiro quando alguém tenta salvar ou testar.
      return [];
    }

    return descriptor.webhookChannels.map((canal) => ({
      key: canal.key,
      label: canal.label,
      url: montarUrlDeWebhook(config.provider, segredo, canal.key),
    }));
  }

  private abrirCofre(config: PaymentProviderConfig): Record<string, string> {
    return this.crypto.decifrar<Record<string, string>>(
      config.credentials,
      contextoDoSelo(config.churchId, config.provider),
    );
  }

  private buscar(churchId: string, provider: PaymentProvider) {
    return this.prisma.paymentProviderConfig.findUnique({
      where: { churchId_provider: { churchId, provider } },
    });
  }

  private async exigir(churchId: string, provider: PaymentProvider) {
    const config = await this.buscar(churchId, provider);

    if (!config) {
      throw new NotFoundException('Integração não configurada nesta igreja');
    }

    return config;
  }

  private exigirCofre() {
    if (!this.crypto.disponivel) {
      throw new ServiceUnavailableException(
        'A chave de criptografia de credenciais não está configurada neste ' +
          'ambiente (PAYMENT_CREDENTIALS_KEY). Fale com o suporte técnico.',
      );
    }
  }

  /**
   * O que sobe para a tela depois de escrever.
   *
   * `credentials` fica de fora por construção — nem o envelope cifrado sai
   * daqui. O que vaza de um endpoint de leitura é o que alguém acaba
   * registrando num log de proxy.
   */
  private paraTela(config: PaymentProviderConfig) {
    return {
      provider: config.provider,
      mode: config.mode,
      enabled: config.enabled,
      isDefault: config.isDefault,
      credentialsHint: config.credentialsHint,
      lastWebhookAt: config.lastWebhookAt,
      updatedAt: config.updatedAt,
      webhooks: this.urlsDeWebhook(config),
    };
  }
}

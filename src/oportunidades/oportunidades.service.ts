import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ChurchModule,
  ChurchStatus,
  OpportunityStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { exigirModulo } from 'src/planos/modulos';
import { contaBloqueadaNaSessao } from 'src/auth/bloqueio';
import {
  encerrarPropostaDeOportunidade,
  notificarOportunidade,
  notificarPropostaDeOportunidade,
  notificarRespostaDaProposta,
} from 'src/notificacoes/notificar';
import {
  resolveImageExtension,
  uploadImageFirebase,
} from 'src/utils/uploadImgFirebase';
import {
  AcompanharCandidaturaDto,
  AtualizarOportunidadeDto,
  CriarOportunidadeDto,
} from './oportunidades.dto';
import {
  caminhosDosCurriculos,
  DadosDaVaga,
  dadosDa,
  formularioPadrao,
  LIMITES,
  normalizarFormulario,
  normalizarSalario,
  Respostas,
  semCaminho,
  validarRespostas,
} from './formulario';
import { apagarDoBucket, baixarDoBucket, salvarNoBucket } from './bucket';
import { limparDescricao, temTexto } from './descricao';

const CAMPOS = {
  id: true,
  title: true,
  company: true,
  description: true,
  location: true,
  isOpen: true,
  closesAt: true,
  data: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * No painel: a situação, quem publicou (ou propôs) e quem revisou, e quem se
 * candidatou, com o contato e as respostas
 */
const CAMPOS_DA_IGREJA = {
  ...CAMPOS,
  status: true,
  rejectionReason: true,
  reviewedAt: true,
  createdBy: { select: { id: true, fullName: true } },
  proposedBy: { select: { id: true, fullName: true } },
  reviewedBy: { select: { id: true, fullName: true } },
  interests: {
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      answers: true,
      // o acompanhamento: só no painel e para quem propôs, nunca ao candidato
      stage: true,
      note: true,
      trackedAt: true,
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          cellphone: true,
          profilePhotoUrl: true,
        },
      },
    },
  },
} as const;

/**
 * O que está no ar para os membros: só a vaga aprovada. A proposta pendente
 * e a recusada nunca chegam a eles — todo `where` do lado do membro começa
 * por aqui.
 */
const PUBLICADA = { status: OpportunityStatus.APPROVED } as const;

/** Aprovada, aberta e no prazo: onde o membro pode se candidatar */
const recebendo = (agora = new Date()): Prisma.OpportunityWhereInput => ({
  ...PUBLICADA,
  isOpen: true,
  OR: [{ closesAt: null }, { closesAt: { gt: agora } }],
});

/** Quantas propostas pendentes um membro pode ter ao mesmo tempo */
const LIMITE_DE_PENDENTES = 5;

const vencida = (closesAt: Date | null) => !!closesAt && closesAt <= new Date();

/**
 * "2026-12-31" vale até o fim desse dia no horário de Brasília.
 * ponytail: -03:00 fixo (o Brasil não tem mais horário de verão); fuso da
 * igreja se um dia houver igreja fora dele.
 */
const fimDoDia = (data: string) =>
  new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(data) ? `${data}T23:59:59.999-03:00` : data,
  );

/** A vaga como o membro vê: sem o formulário (ele vem no detalhe) */
const paraOMembro = ({
  data,
  ...vaga
}: { data: Prisma.JsonValue } & Record<string, any>) => {
  const { imagemUrl = null, cor = null, salario = null } = dadosDa(data);
  return {
    ...vaga,
    imagemUrl,
    cor,
    salario,
    encerrada: !vaga.isOpen || vencida(vaga.closesAt),
  };
};

/** No painel: a configuração aberta em campos e as respostas sem o caminho */
const paraOPainel = ({ data, interests, ...vaga }: any) => {
  const {
    imagemUrl = null,
    cor = null,
    salario = null,
    formulario = { campos: [] },
  } = dadosDa(data);
  return {
    ...vaga,
    imagemUrl,
    cor,
    salario,
    formulario,
    encerrada:
      vaga.status === OpportunityStatus.APPROVED &&
      (!vaga.isOpen || vencida(vaga.closesAt)),
    interests: interests.map(({ answers, ...i }: any) => ({
      ...i,
      respostas: semCaminho(answers),
    })),
  };
};

/**
 * Módulo Oportunidades: o admin da igreja publica vagas de emprego (na igreja
 * ou na empresa de um membro), cada uma com o seu formulário de candidatura;
 * os membros dela se candidatam, e o admin repassa a lista a quem ofereceu.
 */
@Injectable()
export class OportunidadesService {
  private readonly logger = new Logger(OportunidadesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A igreja de que a pessoa é membro agora — ativa e com o módulo no plano.
   * É sempre ela, nunca uma vinda da requisição: ninguém vê as vagas da
   * igreja dos outros. `memberChurchId` só a igreja grava (aceitar o pedido,
   * em Membros); o pedido pendente fica em `requestedChurchId` e não abre
   * nada aqui.
   *
   * O bloqueio vem na mesma busca: estas rotas não passam pelo `RolesGuard`,
   * e o token de quem foi bloqueado ainda vale até 24h.
   */
  private async igrejaDoMembro(userId: string) {
    const pessoa = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        memberChurch: { select: { id: true, status: true } },
        block: { select: { userId: true } },
      },
    });
    if (pessoa?.block) throw contaBloqueadaNaSessao();
    const igreja = pessoa?.memberChurch;
    if (!igreja || igreja.status === ChurchStatus.INACTIVE) {
      throw new ForbiddenException(
        'As oportunidades são só para os membros da igreja',
      );
    }
    await exigirModulo(this.prisma, igreja.id, ChurchModule.OPPORTUNITIES);
    return igreja.id;
  }

  /**
   * As vagas da igreja do membro que estão recebendo candidatura, mais as
   * encerradas em que ele se candidatou — para ainda poder ver e retirar.
   */
  async abertas(userId: string) {
    const churchId = await this.igrejaDoMembro(userId);
    const vagas = await this.prisma.opportunity.findMany({
      where: {
        churchId,
        ...PUBLICADA,
        OR: [recebendo(), { interests: { some: { userId } } }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        ...CAMPOS,
        interests: { where: { userId }, select: { createdAt: true } },
      },
    });
    return vagas.map(({ interests, ...vaga }) => ({
      ...paraOMembro(vaga),
      interessei: interests.length > 0,
    }));
  }

  /**
   * Uma vaga com o formulário, para a página de candidatura. Vaga de outra
   * igreja é 404; a encerrada só aparece para quem se candidatou.
   */
  async detalhe(userId: string, id: string) {
    const churchId = await this.igrejaDoMembro(userId);
    const vaga = await this.prisma.opportunity.findFirst({
      where: { id, churchId, ...PUBLICADA },
      select: {
        ...CAMPOS,
        interests: {
          where: { userId },
          select: { createdAt: true, answers: true },
        },
      },
    });
    if (!vaga) throw new NotFoundException('Oportunidade não encontrada');
    const { interests, ...resto } = vaga;
    const [minha] = interests;
    const membro = paraOMembro(resto);
    if (membro.encerrada && !minha) {
      throw new NotFoundException('Oportunidade não encontrada');
    }
    return {
      ...membro,
      formulario: dadosDa(vaga.data).formulario ?? { campos: [] },
      interessei: !!minha,
      minhaCandidatura: minha
        ? { createdAt: minha.createdAt, respostas: semCaminho(minha.answers) }
        : null,
    };
  }

  /**
   * Candidatura: a vaga tem que ser da igreja do membro (de outra é 404, sem
   * dizer que existe), aberta e no prazo; as respostas passam pelo formulário
   * dela (`validarRespostas`). Repetir não duplica nem troca o que foi
   * enviado: para mudar, retira e manda de novo.
   *
   * O currículo só sobe depois de tudo conferido, e sai do bucket se a
   * gravação falhar.
   */
  async interessar(
    userId: string,
    id: string,
    respostasBrutas?: string,
    curriculo?: Express.Multer.File,
  ) {
    const churchId = await this.igrejaDoMembro(userId);
    const vaga = await this.prisma.opportunity.findFirst({
      where: { id, churchId, ...PUBLICADA },
      select: {
        isOpen: true,
        closesAt: true,
        data: true,
        interests: { where: { userId }, select: { userId: true } },
      },
    });
    if (!vaga) throw new NotFoundException('Oportunidade não encontrada');
    if (vaga.interests.length) return { interessei: true };
    if (!vaga.isOpen || vencida(vaga.closesAt)) {
      throw new ConflictException('Esta oportunidade foi encerrada');
    }

    let entrada: Record<string, unknown> = {};
    if (respostasBrutas) {
      try {
        entrada = JSON.parse(respostasBrutas);
      } catch {
        throw new BadRequestException('Respostas inválidas');
      }
    }

    const formulario = dadosDa(vaga.data).formulario ?? { campos: [] };
    const campoDoCurriculo = formulario.campos.find(
      (c) => c.tipo === 'CURRICULO',
    );
    const comCurriculo = !!campoDoCurriculo && !!curriculo;
    if (comCurriculo) conferirCurriculo(curriculo);
    const respostas: Respostas = validarRespostas(
      formulario,
      entrada,
      comCurriculo,
    );

    let caminho: string | null = null;
    if (comCurriculo) {
      // uuid no caminho: o arquivo não tem URL pública que dê para adivinhar
      caminho = `oportunidades/${id}/curriculos/${userId}-${randomUUID()}.pdf`;
      await salvarNoBucket(caminho, curriculo.buffer, 'application/pdf');
      respostas[campoDoCurriculo.id] = {
        tipo: 'CURRICULO',
        rotulo: campoDoCurriculo.rotulo,
        valor: { caminho, nome: nomeDoArquivo(curriculo.originalname) },
      };
    }

    try {
      await this.prisma.opportunityInterest.create({
        data: {
          opportunityId: id,
          userId,
          answers: respostas as unknown as Prisma.InputJsonObject,
        },
      });
    } catch (erro) {
      if (caminho) await this.apagar([caminho]);
      // dois envios juntos: o segundo bate na chave, e a candidatura já existe
      if (erro?.code === 'P2002') return { interessei: true };
      throw erro;
    }
    return { interessei: true };
  }

  /**
   * Retirar a candidatura só apaga a linha da própria pessoa (e o currículo
   * dela): não precisa ser membro ainda nem a vaga estar aberta — o dado é
   * dela.
   */
  async desinteressar(userId: string, id: string) {
    const minhas = await this.prisma.opportunityInterest.findMany({
      where: { opportunityId: id, userId },
      select: { answers: true },
    });
    await this.prisma.opportunityInterest.deleteMany({
      where: { opportunityId: id, userId },
    });
    await this.apagar(caminhosDosCurriculos(minhas));
    return { interessei: false };
  }

  // ponytail: candidaturas vêm junto da lista; separar em rota própria se as vagas passarem de centenas
  /** As vagas da igreja, de todas as situações, com as candidaturas */
  async daIgreja(churchId: string) {
    const vagas = await this.prisma.opportunity.findMany({
      where: { churchId },
      orderBy: { createdAt: 'desc' },
      select: CAMPOS_DA_IGREJA,
    });
    return vagas.map(paraOPainel);
  }

  /** O que vai para `data` (a parte da configuração que veio no DTO) */
  private dadosDoDto(dto: AtualizarOportunidadeDto): Partial<DadosDaVaga> {
    const dados: Partial<DadosDaVaga> = {};
    if (dto.salario !== undefined) {
      dados.salario = normalizarSalario(dto.salario) ?? undefined;
    }
    if (dto.formulario !== undefined) {
      dados.formulario = normalizarFormulario(dto.formulario);
    }
    return dados;
  }

  /** O que vai para as colunas, de um DTO de criação (admin ou proposta) */
  private colunasDaCriacao(dto: CriarOportunidadeDto) {
    return {
      title: dto.titulo.trim(),
      company: dto.empresa.trim(),
      description: descricaoLimpa(dto.descricao),
      location: dto.local?.trim() || null,
      closesAt: dto.encerraEm ? fimDoDia(dto.encerraEm) : null,
      data: {
        formulario: formularioPadrao(),
        ...this.dadosDoDto(dto),
      } as unknown as Prisma.InputJsonObject,
    };
  }

  /**
   * O que muda numa edição parcial: campo ausente não muda; `local` vazio
   * apaga; `encerraEm`/`salario` nulos tiram o prazo e o salário. O
   * formulário vem inteiro e substitui o anterior — as candidaturas já feitas
   * guardam a cópia do que responderam. `aberta` só vale para o admin.
   */
  private colunasDaEdicao(
    dto: AtualizarOportunidadeDto,
    dadosAtuais: Prisma.JsonValue,
    comAberta: boolean,
  ): Prisma.OpportunityUpdateManyMutationInput {
    const novos = this.dadosDoDto(dto);
    return {
      ...(dto.titulo !== undefined && { title: dto.titulo.trim() }),
      ...(dto.empresa !== undefined && { company: dto.empresa.trim() }),
      ...(dto.descricao !== undefined && {
        description: descricaoLimpa(dto.descricao),
      }),
      ...(dto.local !== undefined && {
        location: dto.local?.trim() || null,
      }),
      ...(comAberta && dto.aberta !== undefined && { isOpen: dto.aberta }),
      ...(dto.encerraEm !== undefined && {
        closesAt: dto.encerraEm ? fimDoDia(dto.encerraEm) : null,
      }),
      ...(Object.keys(novos).length > 0 && {
        data: {
          ...dadosDa(dadosAtuais),
          ...novos,
        } as unknown as Prisma.InputJsonObject,
      }),
    };
  }

  /** A vaga do admin já nasce aprovada: ele é quem aprova */
  async criar(churchId: string, userId: string, dto: CriarOportunidadeDto) {
    const vaga = await this.prisma.opportunity.create({
      data: {
        churchId,
        createdById: userId,
        status: OpportunityStatus.APPROVED,
        isOpen: dto.aberta ?? true,
        ...this.colunasDaCriacao(dto),
      },
      select: CAMPOS_DA_IGREJA,
    });
    await notificarOportunidade(this.prisma, vaga.id, userId);
    return paraOPainel(vaga);
  }

  /**
   * O guard confere que a pessoa é admin da igreja da URL; aqui, que a vaga é
   * dessa igreja — senão trocar o id bastava para mexer na vaga de outra.
   */
  private async daIgrejaOu404(churchId: string, id: string) {
    const vaga = await this.prisma.opportunity.findFirst({
      where: { id, churchId },
      select: { id: true, data: true },
    });
    if (!vaga) throw new NotFoundException('Oportunidade não encontrada');
    return vaga;
  }

  /** O admin edita qualquer vaga da igreja, inclusive a proposta pendente */
  async atualizar(
    churchId: string,
    id: string,
    dto: AtualizarOportunidadeDto,
    quemFez?: string,
  ) {
    const atual = await this.daIgrejaOu404(churchId, id);
    const vaga = await this.prisma.opportunity.update({
      where: { id },
      data: this.colunasDaEdicao(dto, atual.data, true),
      select: CAMPOS_DA_IGREJA,
    });
    // publicada encerrada e aberta agora: é aí que os membros ficam sabendo
    // (proposta pendente não avisa: `notificarOportunidade` só olha aprovada)
    if (dto.aberta) await notificarOportunidade(this.prisma, id, quemFez);
    return paraOPainel(vaga);
  }

  /**
   * Aprova a proposta: vai ao ar para os membros. Só sai de pendente, e numa
   * instrução só (`updateMany` com a situação no `where`): dois admins
   * decidindo ao mesmo tempo, ou quem propôs editando enquanto isso, não se
   * atropelam — quem chega depois leva 409.
   */
  async aprovar(churchId: string, id: string, quemFez: string) {
    await this.decidir(churchId, id, quemFez, {
      status: OpportunityStatus.APPROVED,
      rejectionReason: null,
      isOpen: true,
    });
    await notificarOportunidade(this.prisma, id, quemFez);
    return this.daIgrejaUma(churchId, id);
  }

  /** Recusa a proposta: fica arquivada no painel; quem propôs vê o motivo */
  async recusar(
    churchId: string,
    id: string,
    quemFez: string,
    motivo?: string,
  ) {
    await this.decidir(churchId, id, quemFez, {
      status: OpportunityStatus.REJECTED,
      rejectionReason: motivo?.trim() || null,
    });
    return this.daIgrejaUma(churchId, id);
  }

  private async decidir(
    churchId: string,
    id: string,
    quemFez: string,
    data: Prisma.OpportunityUpdateManyMutationInput,
  ) {
    await this.daIgrejaOu404(churchId, id);
    const { count } = await this.prisma.opportunity.updateMany({
      where: { id, churchId, status: OpportunityStatus.PENDING },
      data: { ...data, reviewedById: quemFez, reviewedAt: new Date() },
    });
    if (!count) {
      throw new ConflictException('Esta proposta já foi decidida');
    }
    await encerrarPropostaDeOportunidade(this.prisma, id);
    await notificarRespostaDaProposta(this.prisma, id, quemFez);
  }

  private async daIgrejaUma(churchId: string, id: string) {
    const vaga = await this.prisma.opportunity.findFirst({
      where: { id, churchId },
      select: CAMPOS_DA_IGREJA,
    });
    return paraOPainel(vaga);
  }

  // ---- propostas dos membros ----------------------------------------------

  /**
   * As propostas da pessoa na igreja de que ela é membro agora. A aprovada
   * vem com os candidatos (quem propôs os vê, como o admin); a pendente e a
   * recusada, sem. Proposta feita em outra igreja (antes de mudar) não
   * aparece: o acesso é pela igreja de agora.
   */
  async minhasPropostas(userId: string) {
    const churchId = await this.igrejaDoMembro(userId);
    const vagas = await this.prisma.opportunity.findMany({
      where: { churchId, proposedById: userId },
      orderBy: { createdAt: 'desc' },
      select: CAMPOS_DA_IGREJA,
    });
    return vagas.map((v) =>
      paraOPainel(
        v.status === OpportunityStatus.APPROVED ? v : { ...v, interests: [] },
      ),
    );
  }

  /**
   * Um membro propõe uma vaga: vai para a igreja do cadastro dele (nunca uma
   * vinda da requisição), pendente, e os admins são avisados. Até
   * `LIMITE_DE_PENDENTES` esperando ao mesmo tempo, para ninguém encher a
   * fila do admin.
   */
  async propor(userId: string, dto: CriarOportunidadeDto) {
    const churchId = await this.igrejaDoMembro(userId);
    const pendentes = await this.prisma.opportunity.count({
      where: {
        churchId,
        proposedById: userId,
        status: OpportunityStatus.PENDING,
      },
    });
    if (pendentes >= LIMITE_DE_PENDENTES) {
      throw new ConflictException(
        `Você já tem ${LIMITE_DE_PENDENTES} propostas esperando o admin. Aguarde a resposta de alguma.`,
      );
    }
    const vaga = await this.prisma.opportunity.create({
      data: {
        churchId,
        createdById: userId,
        proposedById: userId,
        status: OpportunityStatus.PENDING,
        isOpen: true,
        ...this.colunasDaCriacao(dto),
      },
      select: CAMPOS_DA_IGREJA,
    });
    await notificarPropostaDeOportunidade(this.prisma, vaga.id);
    return paraOPainel({ ...vaga, interests: [] });
  }

  /**
   * A proposta da própria pessoa, nesta igreja, na situação pedida. De outra
   * pessoa ou de outra igreja é 404; na situação errada (já decidida), 409.
   */
  private async minhaProposta(
    userId: string,
    id: string,
    status: OpportunityStatus,
  ) {
    const churchId = await this.igrejaDoMembro(userId);
    const vaga = await this.prisma.opportunity.findFirst({
      where: { id, churchId, proposedById: userId },
      select: { id: true, data: true, status: true, churchId: true },
    });
    if (!vaga) throw new NotFoundException('Proposta não encontrada');
    if (vaga.status !== status) {
      throw new ConflictException(
        status === OpportunityStatus.PENDING
          ? 'Esta proposta já foi decidida pelo admin'
          : 'Esta proposta não foi aprovada',
      );
    }
    return vaga;
  }

  /**
   * Quem propôs edita enquanto está pendente. A situação vai no `where` da
   * gravação: se o admin decidiu no meio, nada muda e a pessoa leva 409.
   */
  async editarProposta(
    userId: string,
    id: string,
    dto: AtualizarOportunidadeDto,
  ) {
    const atual = await this.minhaProposta(
      userId,
      id,
      OpportunityStatus.PENDING,
    );
    const { count } = await this.prisma.opportunity.updateMany({
      where: { id, proposedById: userId, status: OpportunityStatus.PENDING },
      data: this.colunasDaEdicao(dto, atual.data, false),
    });
    if (!count) {
      throw new ConflictException('Esta proposta já foi decidida pelo admin');
    }
    const vaga = await this.prisma.opportunity.findUnique({
      where: { id },
      select: CAMPOS_DA_IGREJA,
    });
    return paraOPainel({ ...vaga, interests: [] });
  }

  /** Retira a proposta pendente: some do painel, com a imagem */
  async retirarProposta(userId: string, id: string) {
    await this.minhaProposta(userId, id, OpportunityStatus.PENDING);
    const { count } = await this.prisma.opportunity.deleteMany({
      where: { id, proposedById: userId, status: OpportunityStatus.PENDING },
    });
    if (!count) {
      throw new ConflictException('Esta proposta já foi decidida pelo admin');
    }
    await encerrarPropostaDeOportunidade(this.prisma, id);
    await this.apagar([caminhoDaImagem(id)]);
  }

  async trocarImagemDaProposta(
    userId: string,
    id: string,
    file: Express.Multer.File,
    cor?: string,
  ) {
    const vaga = await this.minhaProposta(
      userId,
      id,
      OpportunityStatus.PENDING,
    );
    return this.gravarImagem(vaga, file, cor);
  }

  async removerImagemDaProposta(userId: string, id: string) {
    const vaga = await this.minhaProposta(
      userId,
      id,
      OpportunityStatus.PENDING,
    );
    return this.tirarImagem(vaga);
  }

  /**
   * Quem propôs acompanha os candidatos da vaga dele (aprovada), com as
   * mesmas regras de ver os candidatos: membro desta igreja, com o módulo.
   */
  async acompanharNaProposta(
    userId: string,
    id: string,
    candidatoId: string,
    dto: AcompanharCandidaturaDto,
  ) {
    await this.minhaProposta(userId, id, OpportunityStatus.APPROVED);
    return this.acompanhar(id, candidatoId, dto);
  }

  /** O currículo de um candidato, para quem propôs a vaga (aprovada) */
  async curriculoDaProposta(userId: string, id: string, candidatoId: string) {
    await this.minhaProposta(userId, id, OpportunityStatus.APPROVED);
    return this.lerCurriculo(id, candidatoId);
  }

  /**
   * A imagem da vaga (a logo); trocar sobrescreve o mesmo arquivo. `cor` é a
   * cor dominante dela, calculada na tela (o arquivo ainda é local lá, sem
   * esbarrar no CORS do bucket); sem cor válida, o crachá usa a do módulo.
   */
  async trocarImagem(
    churchId: string,
    id: string,
    file: Express.Multer.File,
    cor?: string,
  ) {
    return this.gravarImagem(await this.daIgrejaOu404(churchId, id), file, cor);
  }

  async removerImagem(churchId: string, id: string) {
    return this.tirarImagem(await this.daIgrejaOu404(churchId, id));
  }

  /** Grava a imagem de uma vaga já conferida (do admin ou de quem propôs) */
  private async gravarImagem(
    vaga: { id: string; data: Prisma.JsonValue },
    file: Express.Multer.File,
    cor?: string,
  ) {
    if (!file) throw new BadRequestException('Envie a imagem');
    resolveImageExtension(file);
    const { url } = await uploadImageFirebase(file, caminhoDaImagem(vaga.id));
    await this.prisma.opportunity.update({
      where: { id: vaga.id },
      data: {
        data: {
          ...dadosDa(vaga.data),
          imagemUrl: url,
          cor: /^#[0-9a-f]{6}$/i.test(cor ?? '')
            ? cor.toLowerCase()
            : undefined,
        } as unknown as Prisma.InputJsonObject,
      },
    });
    return { imagemUrl: url };
  }

  private async tirarImagem(vaga: { id: string; data: Prisma.JsonValue }) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- a cor vai junto com a imagem
    const { imagemUrl, cor, ...resto } = dadosDa(vaga.data);
    await this.prisma.opportunity.update({
      where: { id: vaga.id },
      data: { data: resto as unknown as Prisma.InputJsonObject },
    });
    if (imagemUrl) await this.apagar([caminhoDaImagem(vaga.id)]);
    return { imagemUrl: null };
  }

  /** O admin acompanha os candidatos de uma vaga da igreja dele */
  async acompanharNoPainel(
    churchId: string,
    id: string,
    candidatoId: string,
    dto: AcompanharCandidaturaDto,
  ) {
    await this.daIgrejaOu404(churchId, id);
    return this.acompanhar(id, candidatoId, dto);
  }

  /**
   * A etapa e a anotação de uma candidatura desta vaga (a vaga já foi
   * conferida por quem chama). Campo ausente não muda; nota vazia apaga.
   */
  private async acompanhar(
    id: string,
    candidatoId: string,
    dto: AcompanharCandidaturaDto,
  ) {
    try {
      const c = await this.prisma.opportunityInterest.update({
        where: {
          opportunityId_userId: { opportunityId: id, userId: candidatoId },
        },
        data: {
          ...(dto.etapa !== undefined && { stage: dto.etapa }),
          ...(dto.nota !== undefined && { note: dto.nota.trim() || null }),
          trackedAt: new Date(),
        },
        select: { stage: true, note: true, trackedAt: true },
      });
      return c;
    } catch (erro) {
      // a candidatura foi retirada no meio, ou nunca foi desta vaga
      if (erro?.code === 'P2025') {
        throw new NotFoundException('Candidatura não encontrada');
      }
      throw erro;
    }
  }

  /** O currículo de um candidato, para o admin da igreja da vaga */
  async curriculo(churchId: string, id: string, userId: string) {
    await this.daIgrejaOu404(churchId, id);
    return this.lerCurriculo(id, userId);
  }

  private async lerCurriculo(id: string, userId: string) {
    const candidatura = await this.prisma.opportunityInterest.findUnique({
      where: { opportunityId_userId: { opportunityId: id, userId } },
      select: { answers: true },
    });
    const [caminho] = candidatura ? caminhosDosCurriculos([candidatura]) : [];
    if (!caminho) throw new NotFoundException('Currículo não encontrado');
    const resposta = Object.values(
      candidatura.answers as unknown as Respostas,
    ).find((r) => r.tipo === 'CURRICULO');
    return {
      arquivo: await baixarDoBucket(caminho),
      nome: (resposta?.valor as any)?.nome ?? 'curriculo.pdf',
    };
  }

  /** Apaga a vaga, as candidaturas e os arquivos delas (imagem e currículos) */
  async excluir(churchId: string, id: string) {
    await this.daIgrejaOu404(churchId, id);
    const candidaturas = await this.prisma.opportunityInterest.findMany({
      where: { opportunityId: id },
      select: { answers: true },
    });
    await this.prisma.opportunity.delete({ where: { id } });
    await encerrarPropostaDeOportunidade(this.prisma, id);
    await this.apagar([
      caminhoDaImagem(id),
      ...caminhosDosCurriculos(candidaturas),
    ]);
  }

  /** Arquivo que sobra no bucket não pode derrubar quem apagou a linha */
  private async apagar(caminhos: string[]) {
    try {
      await apagarDoBucket(caminhos);
    } catch (erro) {
      this.logger.error(
        `Arquivos não apagados (${caminhos}): ${erro?.message}`,
      );
    }
  }
}

const caminhoDaImagem = (id: string) => `oportunidades/${id}/imagem`;

/** A descrição limpa (ver `descricao.ts`); vazia depois de limpar é recusada */
function descricaoLimpa(html: string) {
  const limpa = limparDescricao(html);
  if (!temTexto(limpa)) throw new BadRequestException('Descreva a vaga');
  return limpa;
}

function conferirCurriculo(file: Express.Multer.File) {
  // o mime vem do cliente: confere também a assinatura do PDF
  const ehPdf =
    file.mimetype === 'application/pdf' &&
    file.buffer?.subarray(0, 5).toString() === '%PDF-';
  if (!ehPdf) throw new BadRequestException('O currículo tem que ser um PDF');
  if (file.size > LIMITES.curriculoBytes) {
    throw new BadRequestException('O currículo vai até 5 MB');
  }
}

/** Só para o nome do download: sem caminho nem caracteres de controle */
const nomeDoArquivo = (original?: string) =>
  (original ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(-120) ||
  'curriculo.pdf';

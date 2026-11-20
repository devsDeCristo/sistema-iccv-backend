import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChurchModule, ChurchStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { exigirModulo } from 'src/planos/modulos';
import { contaBloqueadaNaSessao } from 'src/auth/bloqueio';
import { notificarOportunidade } from 'src/notificacoes/notificar';
import {
  resolveImageExtension,
  uploadImageFirebase,
} from 'src/utils/uploadImgFirebase';
import {
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

/** No painel: quem publicou e quem se candidatou, com o contato e as respostas */
const CAMPOS_DA_IGREJA = {
  ...CAMPOS,
  createdBy: { select: { id: true, fullName: true } },
  interests: {
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      answers: true,
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

/** Aberta e no prazo: o que o membro pode ver e onde pode se candidatar */
const recebendo = (agora = new Date()): Prisma.OpportunityWhereInput => ({
  isOpen: true,
  OR: [{ closesAt: null }, { closesAt: { gt: agora } }],
});

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
    encerrada: !vaga.isOpen || vencida(vaga.closesAt),
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
      where: { id, churchId },
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
      where: { id, churchId },
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
  /** As vagas da igreja, abertas e encerradas, com as candidaturas */
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

  async criar(churchId: string, userId: string, dto: CriarOportunidadeDto) {
    const data: DadosDaVaga = {
      formulario: formularioPadrao(),
      ...this.dadosDoDto(dto),
    };
    const vaga = await this.prisma.opportunity.create({
      data: {
        churchId,
        createdById: userId,
        title: dto.titulo.trim(),
        company: dto.empresa.trim(),
        description: dto.descricao.trim(),
        location: dto.local?.trim() || null,
        isOpen: dto.aberta ?? true,
        closesAt: dto.encerraEm ? fimDoDia(dto.encerraEm) : null,
        data: data as unknown as Prisma.InputJsonObject,
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

  /**
   * Campo ausente não muda; `local` vazio apaga; `encerraEm`/`salario` nulos
   * tiram o prazo e o salário. O formulário vem inteiro e substitui o
   * anterior — as candidaturas já feitas guardam a cópia do que responderam.
   */
  async atualizar(
    churchId: string,
    id: string,
    dto: AtualizarOportunidadeDto,
    quemFez?: string,
  ) {
    const atual = await this.daIgrejaOu404(churchId, id);
    const novos = this.dadosDoDto(dto);
    const mudouDados = Object.keys(novos).length > 0;
    const vaga = await this.prisma.opportunity.update({
      where: { id },
      data: {
        ...(dto.titulo !== undefined && { title: dto.titulo.trim() }),
        ...(dto.empresa !== undefined && { company: dto.empresa.trim() }),
        ...(dto.descricao !== undefined && {
          description: dto.descricao.trim(),
        }),
        ...(dto.local !== undefined && {
          location: dto.local?.trim() || null,
        }),
        ...(dto.aberta !== undefined && { isOpen: dto.aberta }),
        ...(dto.encerraEm !== undefined && {
          closesAt: dto.encerraEm ? fimDoDia(dto.encerraEm) : null,
        }),
        ...(mudouDados && {
          data: {
            ...dadosDa(atual.data),
            ...novos,
          } as unknown as Prisma.InputJsonObject,
        }),
      },
      select: CAMPOS_DA_IGREJA,
    });
    // publicada encerrada e aberta agora: é aí que os membros ficam sabendo
    if (dto.aberta) await notificarOportunidade(this.prisma, id, quemFez);
    return paraOPainel(vaga);
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
    const atual = await this.daIgrejaOu404(churchId, id);
    if (!file) throw new BadRequestException('Envie a imagem');
    resolveImageExtension(file);
    const { url } = await uploadImageFirebase(file, caminhoDaImagem(id));
    await this.prisma.opportunity.update({
      where: { id },
      data: {
        data: {
          ...dadosDa(atual.data),
          imagemUrl: url,
          cor: /^#[0-9a-f]{6}$/i.test(cor ?? '')
            ? cor.toLowerCase()
            : undefined,
        } as unknown as Prisma.InputJsonObject,
      },
    });
    return { imagemUrl: url };
  }

  async removerImagem(churchId: string, id: string) {
    const atual = await this.daIgrejaOu404(churchId, id);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- a cor vai junto com a imagem
    const { imagemUrl, cor, ...resto } = dadosDa(atual.data);
    await this.prisma.opportunity.update({
      where: { id },
      data: { data: resto as unknown as Prisma.InputJsonObject },
    });
    if (imagemUrl) await this.apagar([caminhoDaImagem(id)]);
    return { imagemUrl: null };
  }

  /** O currículo de um candidato, para o admin da igreja da vaga */
  async curriculo(churchId: string, id: string, userId: string) {
    await this.daIgrejaOu404(churchId, id);
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

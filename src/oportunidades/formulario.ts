import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * O formulário de candidatura de cada vaga, e as respostas de quem se
 * candidata. Os dois moram em JSON (`Opportunity.data.formulario` e
 * `OpportunityInterest.answers`): são sempre lidos junto da vaga e da
 * candidatura, e nunca consultados à parte.
 */

/** Os campos que já vêm prontos (rótulo fixo; o admin só tira ou exige) */
export const TIPOS_PADRAO = [
  'CURRICULO',
  'PRETENSAO_SALARIAL',
  'MENSAGEM',
  'REDE_SOCIAL',
] as const;
/** As perguntas que o admin escreve */
export const TIPOS_PROPRIOS = [
  'TEXTO',
  'SELECAO',
  'CAIXAS',
  'OPCAO_UNICA',
] as const;
export type TipoDeCampo =
  | (typeof TIPOS_PADRAO)[number]
  | (typeof TIPOS_PROPRIOS)[number];

/** Um campo para cada rede; `dominio` nulo aceita qualquer site */
export const REDES = {
  linkedin: { rotulo: 'LinkedIn', dominio: 'linkedin.com' },
  instagram: { rotulo: 'Instagram', dominio: 'instagram.com' },
  facebook: { rotulo: 'Facebook', dominio: 'facebook.com' },
  github: { rotulo: 'GitHub', dominio: 'github.com' },
  tiktok: { rotulo: 'TikTok', dominio: 'tiktok.com' },
  x: { rotulo: 'X (Twitter)', dominio: 'x.com|twitter.com' },
  site: { rotulo: 'Site ou portfólio', dominio: null },
} as const;
export type Rede = keyof typeof REDES;

export interface Campo {
  id: string;
  tipo: TipoDeCampo;
  rotulo: string;
  obrigatorio: boolean;
  /** só em `REDE_SOCIAL` */
  rede?: Rede;
  /** só em `SELECAO`, `CAIXAS` e `OPCAO_UNICA` */
  opcoes?: string[];
}

export interface Formulario {
  campos: Campo[];
}

export interface Salario {
  min: number;
  max?: number;
}

/** O que a vaga guarda em `Opportunity.data` */
export interface DadosDaVaga {
  imagemUrl?: string;
  /** onde a imagem está no bucket (cada envio num arquivo novo); nunca sai da API */
  imagemCaminho?: string;
  /** a cor dominante da logo (`#rrggbb`), tirada na tela de quem sobe; tinge o crachá */
  cor?: string;
  salario?: Salario;
  formulario?: Formulario;
}

/** Cada resposta guarda tipo e rótulo: editar o campo depois não a apaga */
export interface Resposta {
  tipo: TipoDeCampo;
  rotulo: string;
  /** currículo: `{ caminho, nome }`; pretensão: `Salario`; caixas: lista */
  valor: unknown;
}
export type Respostas = Record<string, Resposta>;

const ROTULO_PADRAO: Record<
  Exclude<(typeof TIPOS_PADRAO)[number], 'REDE_SOCIAL'>,
  string
> = {
  CURRICULO: 'Currículo',
  PRETENSAO_SALARIAL: 'Pretensão salarial',
  MENSAGEM: 'Mensagem',
};

const idDoPadrao = (tipo: TipoDeCampo, rede?: Rede) =>
  tipo === 'REDE_SOCIAL' ? `rede-${rede}` : tipo.toLowerCase();

const padrao = (tipo: TipoDeCampo, rede?: Rede): Campo => ({
  id: idDoPadrao(tipo, rede),
  tipo,
  rotulo: rede ? REDES[rede].rotulo : ROTULO_PADRAO[tipo],
  obrigatorio: false,
  ...(rede && { rede }),
});

/** A vaga nova nasce com estes, todos opcionais */
export const formularioPadrao = (): Formulario => ({
  campos: [
    padrao('CURRICULO'),
    padrao('PRETENSAO_SALARIAL'),
    padrao('MENSAGEM'),
    padrao('REDE_SOCIAL', 'linkedin'),
    padrao('REDE_SOCIAL', 'instagram'),
  ],
});

export const LIMITES = {
  campos: 20,
  rotulo: 200,
  opcoes: 20,
  opcao: 100,
  mensagem: 1000,
  texto: 2000,
  url: 300,
  salario: 1_000_000_000,
  curriculoBytes: 5 * 1024 * 1024,
};

const erro = (mensagem: string) => new BadRequestException(mensagem);
const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Valor ou faixa; `null` quando vazio */
export function normalizarSalario(
  entrada: unknown,
  nome = 'Salário',
): Salario | null {
  if (entrada === null || entrada === undefined) return null;
  const { min, max } = (entrada ?? {}) as Record<string, unknown>;
  const numero = (v: unknown) =>
    v === null || v === undefined || v === '' ? undefined : Number(v);
  const de = numero(min);
  const ate = numero(max);
  if (de === undefined && ate === undefined) return null;
  const valido = (v?: number) =>
    v === undefined || (Number.isFinite(v) && v >= 0 && v <= LIMITES.salario);
  if (de === undefined || !valido(de) || !valido(ate)) {
    throw erro(`${nome}: informe um valor válido`);
  }
  if (ate !== undefined && ate < de) {
    throw erro(`${nome}: o máximo não pode ser menor que o mínimo`);
  }
  const arredonda = (v: number) => Math.round(v * 100) / 100;
  return ate === undefined || ate === de
    ? { min: arredonda(de) }
    : { min: arredonda(de), max: arredonda(ate) };
}

/**
 * Confere o formulário que o admin montou e devolve a versão limpa: os campos
 * padrão com id e rótulo fixos, no máximo um de cada (uma rede, um campo);
 * as perguntas próprias com enunciado e, nas de escolha, de 2 a 20 opções.
 */
export function normalizarFormulario(entrada: unknown): Formulario {
  const campos = (entrada as Formulario)?.campos;
  if (!Array.isArray(campos)) throw erro('Formulário inválido');
  if (campos.length > LIMITES.campos) {
    throw erro(`O formulário aceita até ${LIMITES.campos} campos`);
  }

  const vistos = new Set<string>();
  return {
    campos: campos.map((c: any, i): Campo => {
      const tipo = c?.tipo as TipoDeCampo;
      const obrigatorio = c?.obrigatorio === true;
      const onde = `Campo ${i + 1}`;

      if ((TIPOS_PADRAO as readonly string[]).includes(tipo)) {
        const rede = tipo === 'REDE_SOCIAL' ? (c.rede as Rede) : undefined;
        if (tipo === 'REDE_SOCIAL' && !(rede in REDES)) {
          throw erro(`${onde}: rede social desconhecida`);
        }
        const campo = { ...padrao(tipo, rede), obrigatorio };
        if (vistos.has(campo.id)) {
          throw erro(`${campo.rotulo} aparece mais de uma vez no formulário`);
        }
        vistos.add(campo.id);
        return campo;
      }

      if (!(TIPOS_PROPRIOS as readonly string[]).includes(tipo)) {
        throw erro(`${onde}: tipo de campo desconhecido`);
      }
      const rotulo = texto(c.rotulo);
      if (!rotulo) throw erro(`${onde}: escreva a pergunta`);
      if (rotulo.length > LIMITES.rotulo) {
        throw erro(`${onde}: a pergunta passa de ${LIMITES.rotulo} caracteres`);
      }
      // o id fica (as respostas apontam para ele); sem um válido, nasce um
      let id =
        typeof c.id === 'string' &&
        /^[\w-]{1,40}$/.test(c.id) &&
        // `__proto__`, `constructor`...: as respostas são indexadas pelo id
        !(c.id in Object.prototype)
          ? c.id
          : randomUUID();
      if (vistos.has(id)) id = randomUUID();
      vistos.add(id);

      if (tipo === 'TEXTO') return { id, tipo, rotulo, obrigatorio };

      const opcoes: string[] = Array.isArray(c.opcoes)
        ? [...new Set<string>(c.opcoes.map(texto).filter(Boolean))]
        : [];
      if (opcoes.length < 2 || opcoes.length > LIMITES.opcoes) {
        throw erro(`${rotulo}: dê de 2 a ${LIMITES.opcoes} opções`);
      }
      if (opcoes.some((o) => o.length > LIMITES.opcao)) {
        throw erro(`${rotulo}: cada opção vai até ${LIMITES.opcao} caracteres`);
      }
      return { id, tipo, rotulo, obrigatorio, opcoes };
    }),
  };
}

/** `https://` opcional na digitação; o domínio tem que ser o da rede */
function normalizarLink(valor: string, rede: Rede, rotulo: string) {
  const comEsquema = /^https?:\/\//i.test(valor) ? valor : `https://${valor}`;
  let url: URL;
  try {
    url = new URL(comEsquema);
  } catch {
    throw erro(`${rotulo}: link inválido`);
  }
  const dominio = REDES[rede].dominio;
  const host = url.hostname.toLowerCase();
  const daRede =
    !dominio ||
    dominio.split('|').some((d) => host === d || host.endsWith(`.${d}`));
  if (!/^https?:$/.test(url.protocol) || !host.includes('.') || !daRede) {
    throw erro(`${rotulo}: link inválido`);
  }
  if (url.href.length > LIMITES.url) throw erro(`${rotulo}: link longo demais`);
  return url.href;
}

/**
 * Confere a candidatura contra o formulário da vaga e devolve as respostas
 * limpas. O currículo vem à parte (é arquivo): aqui só se exige que tenha
 * vindo; o service o guarda e completa a resposta com o caminho.
 *
 * Campo que não está no formulário é ignorado.
 */
export function validarRespostas(
  formulario: Formulario,
  entrada: Record<string, unknown>,
  temCurriculo: boolean,
): Respostas {
  const respostas: Respostas = {};

  for (const campo of formulario.campos) {
    const bruto = entrada?.[campo.id];
    const { tipo, rotulo } = campo;
    let valor: unknown;

    switch (tipo) {
      case 'CURRICULO':
        valor = temCurriculo ? true : undefined;
        break;
      case 'PRETENSAO_SALARIAL':
        valor = normalizarSalario(bruto, rotulo) ?? undefined;
        break;
      case 'MENSAGEM':
      case 'TEXTO': {
        const limite = tipo === 'MENSAGEM' ? LIMITES.mensagem : LIMITES.texto;
        valor = texto(bruto) || undefined;
        if ((valor as string)?.length > limite) {
          throw erro(`${rotulo}: até ${limite} caracteres`);
        }
        break;
      }
      case 'REDE_SOCIAL':
        valor = texto(bruto)
          ? normalizarLink(texto(bruto), campo.rede, rotulo)
          : undefined;
        break;
      case 'SELECAO':
      case 'OPCAO_UNICA':
        valor = texto(bruto) || undefined;
        if (valor && !campo.opcoes.includes(valor as string)) {
          throw erro(`${rotulo}: escolha uma das opções`);
        }
        break;
      case 'CAIXAS': {
        const marcadas = Array.isArray(bruto) ? bruto.map(texto) : [];
        if (marcadas.some((m) => !campo.opcoes.includes(m))) {
          throw erro(`${rotulo}: escolha entre as opções`);
        }
        // na ordem do formulário, sem repetir
        const escolhidas = campo.opcoes.filter((o) => marcadas.includes(o));
        valor = escolhidas.length ? escolhidas : undefined;
        break;
      }
    }

    if (valor === undefined) {
      if (campo.obrigatorio) {
        throw erro(
          tipo === 'CURRICULO'
            ? 'Envie o currículo: esta vaga pede'
            : `Preencha "${rotulo}": é obrigatório`,
        );
      }
      continue;
    }
    if (tipo !== 'CURRICULO') respostas[campo.id] = { tipo, rotulo, valor };
  }

  return respostas;
}

/** O caminho do currículo no bucket nunca sai da API */
export const semCaminho = (respostas: unknown): Respostas =>
  Object.fromEntries(
    Object.entries((respostas ?? {}) as Respostas).map(([id, r]) => [
      id,
      r.tipo === 'CURRICULO'
        ? { ...r, valor: { nome: (r.valor as any)?.nome ?? 'curriculo.pdf' } }
        : r,
    ]),
  );

/** Os currículos guardados numa leva de candidaturas */
export const caminhosDosCurriculos = (candidaturas: { answers: unknown }[]) =>
  candidaturas.flatMap(({ answers }) =>
    Object.values((answers ?? {}) as Respostas)
      .filter((r) => r.tipo === 'CURRICULO')
      .map((r) => (r.valor as any)?.caminho)
      .filter((c): c is string => typeof c === 'string'),
  );

/** `Opportunity.data` como objeto, nunca nulo */
export const dadosDa = (data: unknown): DadosDaVaga =>
  data && typeof data === 'object' && !Array.isArray(data)
    ? (data as DadosDaVaga)
    : {};

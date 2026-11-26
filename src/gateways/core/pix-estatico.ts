import { CredentialField } from './gateway.types';

/**
 * Pix estático: o "Pix Copia e Cola" fixo de uma chave da igreja, colado na
 * configuração do gateway. Com ele, quem escolhe Pix vê o QR desse código, e
 * o gateway não é chamado — existe para quando o gateway ainda não liberou o
 * Pix dele (o PayPal faz análise antes).
 *
 * Não há aviso nem conferência: nenhum gateway sabe desse pagamento. A
 * cobrança fica aguardando até alguém dar baixa pela tela.
 */
export const CAMPO_DE_PIX_ESTATICO = 'staticPixCode';

/** O `checkoutId` do Pix estático: não existe pedido do lado de lá */
const PREFIXO = 'PIX-ESTATICO-';

export const checkoutDoPixEstatico = (referenceId: string) =>
  `${PREFIXO}${referenceId}`;

export const ehPixEstatico = (checkoutId?: string | null) =>
  !!checkoutId?.startsWith(PREFIXO);

export function campoDePixEstatico(): CredentialField {
  return {
    key: CAMPO_DE_PIX_ESTATICO,
    label: 'Pix estático (Copia e Cola)',
    required: false,
    secret: false,
    staticPix: true,
    help: 'Gere no app do banco da igreja um Pix Copia e Cola sem valor e cole aqui.',
  };
}

/** O código gravado, ou nulo com o Pix estático desligado */
export const pixEstatico = (credenciais?: Record<string, string>) =>
  credenciais?.[CAMPO_DE_PIX_ESTATICO]?.trim() || null;

/**
 * O código como o app do banco gerou. Copiado de mensagem, PDF ou da tela do
 * banco, ele chega quebrado em linhas e às vezes com caractere invisível
 * (espaço de largura zero, BOM) — que o CRC não perdoa. Espaço comum fica:
 * é parte do código ("SAO PAULO").
 */
export const limparBrCode = (codigo: string) =>
  codigo
    .replace(/[\r\n\t\u200B-\u200D\u2060\uFEFF]/g, '')
    // espaço "especial" que alguns apps põem no lugar do comum ao copiar: o
    // texto parece igual, mas o CRC é do espaço comum ("SAO PAULO")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .trim();

/** CRC16-CCITT (0x1021, início 0xFFFF) do BR Code, em 4 hex maiúsculos */
export function crcDoBrCode(corpo: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(corpo, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Os campos de um nível do BR Code (id, tamanho, valor); nulo se não fecha */
function lerCampos(texto: string): Map<string, string> | null {
  const { campos, quebraEm } = percorrerCampos(texto);
  return quebraEm === null ? campos : null;
}

/** Lê os campos até onde fecham; `quebraEm` é o id do campo que não fecha */
function percorrerCampos(texto: string) {
  const campos = new Map<string, string>();
  let i = 0;
  while (i < texto.length) {
    const id = texto.slice(i, i + 2);
    const tamanho = texto.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(tamanho)) {
      return { campos, quebraEm: id };
    }
    const valor = texto.slice(i + 4, i + 4 + Number(tamanho));
    if (valor.length !== Number(tamanho)) return { campos, quebraEm: id };
    campos.set(id, valor);
    i += 4 + Number(tamanho);
  }
  return { campos, quebraEm: null as string | null };
}

/** O nome de cada campo do BR Code, para dizer onde está o problema */
const NOME_DO_CAMPO: Record<string, string> = {
  '00': 'versão',
  '01': 'tipo do Pix',
  '26': 'chave Pix',
  '52': 'categoria',
  '53': 'moeda',
  '54': 'valor',
  '58': 'país',
  '59': 'nome do recebedor',
  '60': 'cidade',
  '61': 'CEP',
  '62': 'informações adicionais',
  '63': 'final do código',
};

/** Parece uma chave Pix solta (e-mail, telefone, CPF/CNPJ, aleatória), e não o código */
const pareceChave = (texto: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto) ||
  /^\+?[\d\s().-]{10,18}$/.test(texto) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(texto);

/**
 * O que impede o código de servir de Pix estático, ou nulo se serve.
 *
 * Não basta o CRC bater: o código tem que ser o da **chave**, sem valor. Um
 * Pix com valor fixo cobraria o mesmo de todo mundo (a tela diz R$ 250, o
 * banco pede R$ 10), e um Pix de cobrança (dinâmico) é de uso único — o
 * primeiro paga, os outros têm o código recusado pelo banco.
 */
export function problemaNoPixEstatico(codigo: string): string | null {
  // Sem dizer qual seria o final certo: com ele, dava para "consertar" à mão
  // um código com parte da chave faltando — e o Pix iria para outra conta
  const deNovo = 'copie de novo direto do app do banco, sem editar';

  if (!codigo.startsWith('000201')) {
    return pareceChave(codigo)
      ? 'isso é a chave Pix, não o código: no app do banco, gere um Pix para receber (sem valor) e copie o "Pix Copia e Cola"'
      : `o código precisa começar com 000201, e este começa com "${codigo.slice(
          0,
          6,
        )}"; ${deNovo}`;
  }
  if (!/6304[0-9A-Fa-f]{4}$/.test(codigo)) {
    return `o final do código está faltando (ele termina em 6304 seguido de 4 letras ou números, e este termina em "${codigo.slice(
      -8,
    )}"); ${deNovo}, até o fim`;
  }
  const crc = crcDoBrCode(codigo.slice(0, -4));
  if (crc !== codigo.slice(-4).toUpperCase()) {
    return `o código foi alterado ou está com parte faltando no meio (o final "${codigo.slice(
      -4,
    )}" não confere com o resto); ${deNovo}`;
  }

  const { campos, quebraEm } = percorrerCampos(codigo);
  if (quebraEm !== null) {
    const nome = NOME_DO_CAMPO[quebraEm];
    return `o código está com o tamanho errado a partir do campo ${quebraEm}${
      nome ? ` (${nome})` : ''
    }; ${deNovo}`;
  }

  // a conta Pix fica num dos campos 26 a 51, identificada pelo GUI
  const pix = [...campos]
    .filter(([id]) => Number(id) >= 26 && Number(id) <= 51)
    .map(([, valor]) => lerCampos(valor))
    .find((sub) => sub?.get('00')?.toLowerCase() === 'br.gov.bcb.pix');
  if (!pix) return 'o código não é de Pix';

  if (campos.get('01') === '12' || pix.has('25') || !pix.has('01')) {
    return 'esse é um Pix de cobrança, de uso único; gere um Pix Copia e Cola da chave da igreja';
  }
  if (campos.has('54')) {
    return 'o código tem valor fixo; gere sem valor, porque o valor muda a cada inscrição';
  }
  return null;
}

/** Serve de Pix estático: ver `problemaNoPixEstatico` */
export const brCodeValido = (codigo: string) =>
  problemaNoPixEstatico(codigo) === null;

/** Os campos de volta em texto, na ordem dos ids (o 00 primeiro, como manda o BR Code) */
const escreverCampos = (campos: Map<string, string>) =>
  [...campos]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, valor]) => `${id}${String(valor.length).padStart(2, '0')}${valor}`,
    )
    .join('');

/**
 * O identificador do Pix (`txid`, até 25 letras e números): o nome do
 * inscrito e um pedaço da referência. É o que a igreja lê no extrato do banco
 * para saber de quem é a inscrição — quem paga pode ser outra pessoa (o pai
 * pagando a do filho), e duas inscrições de R$ 250 ficavam iguais.
 */
export function identificadorDoPix(nome: string, referencia: string): string {
  const letras = (texto: string) =>
    texto
      .normalize('NFD')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase();
  return `${letras(nome).slice(0, 21)}${letras(referencia).slice(0, 4)}`;
}

/**
 * O código colado pela igreja (o da chave, sem valor) com o valor desta
 * cobrança e o identificador dela, e o CRC refeito. O app do banco já abre
 * com o valor certo — ninguém digita, ninguém erra. Continua sendo Pix
 * estático: vai direto para a conta da igreja, sem aviso de pagamento.
 *
 * Código que não fecha (gravado antes da conferência do salvar) volta como
 * está: melhor o QR sem valor que nenhum.
 */
export function pixEstaticoComValor(
  codigo: string,
  centavos: number,
  identificador: string,
): string {
  const campos = lerCampos(codigo);
  if (!campos) return codigo;

  campos.delete('63');
  campos.set('54', (centavos / 100).toFixed(2));
  const adicionais = lerCampos(campos.get('62') ?? '') ?? new Map();
  adicionais.set('05', identificador || '***');
  campos.set('62', escreverCampos(adicionais));

  const corpo = `${escreverCampos(campos)}6304`;
  return corpo + crcDoBrCode(corpo);
}

/**
 * Os dois códigos são da mesma chave e recebedor? Compara sem valor,
 * identificador e CRC — o que muda de uma cobrança para outra.
 */
export function mesmaChave(a?: string | null, b?: string | null): boolean {
  const base = (codigo?: string | null) => {
    const campos = codigo ? lerCampos(codigo) : null;
    if (!campos) return null;
    ['54', '62', '63'].forEach((id) => campos.delete(id));
    return escreverCampos(campos);
  };
  const [x, y] = [base(a), base(b)];
  return x !== null && x === y;
}

/** O código fecha: começo, final, CRC e o tamanho de cada campo */
const fecha = (codigo: string) =>
  /^000201.*6304[0-9A-Fa-f]{4}$/.test(codigo) &&
  crcDoBrCode(codigo.slice(0, -4)) === codigo.slice(-4).toUpperCase() &&
  lerCampos(codigo) !== null;

/**
 * Tira o espaço que a cópia inventou. Código copiado de PDF vem com espaço
 * onde o PDF quebrava a linha ("5904CNI C6009…"), e apagar todos os espaços
 * não serve — "SAO PAULO" tem um de verdade. Então tenta tirar cada espaço
 * (e depois dois, três…) e fica com a versão que fecha: CRC e tamanhos
 * batendo juntos não acontecem por acaso. Nenhuma fechando, volta como veio,
 * e a mensagem de `problemaNoPixEstatico` diz o que há.
 */
export function repararBrCode(codigo: string): string {
  if (fecha(codigo)) return codigo;

  const espacos = [...codigo].flatMap((c, i) => (c === ' ' ? [i] : []));
  // ponytail: busca por combinações, até 10 espaços (1023 tentativas)
  if (!espacos.length || espacos.length > 10) return codigo;

  const sem = (posicoes: number[]) =>
    [...codigo].filter((_, i) => !posicoes.includes(i)).join('');

  const combinacoes = (de: number[], k: number): number[][] =>
    k === 0
      ? [[]]
      : de.flatMap((p, i) =>
          combinacoes(de.slice(i + 1), k - 1).map((resto) => [p, ...resto]),
        );

  for (let k = 1; k <= espacos.length; k++) {
    for (const posicoes of combinacoes(espacos, k)) {
      const candidato = sem(posicoes);
      if (fecha(candidato)) return candidato;
    }
  }
  return codigo;
}

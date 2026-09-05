import { ROLE_LABELS } from 'src/auth/roles';

/**
 * Campos que nunca entram no antes/depois: ruído de controle, credencial ou id.
 * A tela é para gente, e id não diz nada a ninguém — a identificação do
 * registro já está na frase da linha.
 */
const HIDDEN_FIELDS = new Set(['createdAt', 'updatedAt', 'updateAt']);

const FIELD_LABELS: Record<string, string> = {
  amount: 'Valor',
  badgeName: 'Nome no crachá',
  birthday: 'Nascimento',
  capacity: 'Capacidade',
  cellphone: 'Celular',
  city: 'Cidade',
  content: 'Conteúdo',
  codeHash: 'Código de redefinição',
  cpf: 'CPF',
  data: 'Local e descrição',
  password: 'Senha',
  description: 'Descrição',
  email: 'E-mail',
  emergencyContact: 'Contato de emergência',
  endDate: 'Fim',
  fullName: 'Nome',
  isPublished: 'Publicada',
  leadershipPosition: 'Cargo de liderança',
  method: 'Método',
  name: 'Nome',
  neighborhood: 'Bairro',
  note: 'Observação',
  notes: 'Observações',
  payload: 'Dados da transação',
  price: 'Preço',
  profession: 'Profissão',
  profilePhotoUrl: 'Foto de perfil',
  receivedFrom: 'Origem',
  religion: 'Religião',
  role: 'Permissão',
  startDate: 'Início',
  state: 'Estado',
  status: 'Status',
  summary: 'Resumo',
  ticketHash: 'Ticket de redefinição',
  title: 'Título',
  worker: 'Obreiro',
};

export type LogChange = {
  field: string;
  label: string;
  before: string;
  after: string;
};

/**
 * Enum cru na tela é o mesmo problema do id: ninguém lê "IN_ANALYSIS". Os
 * rótulos acompanham os que o painel já usa nas listas de pagamento.
 */
const ENUM_LABELS: Record<string, Record<string, string>> = {
  status: {
    PAID: 'Pago',
    IN_ANALYSIS: 'Em análise',
    DECLINED: 'Recusado',
    CANCELED: 'Cancelado',
    WAITING: 'Aguardando',
    REFUNDED: 'Reembolsado',
    // check-in
    PENDING: 'Não chegou',
    QUEUED: 'Na fila',
    IN_PROGRESS: 'Em atendimento',
    DONE: 'Concluído',
  },
  method: {
    PIX: 'Pix',
    CREDIT_CARD: 'Cartão de Crédito',
    DEBIT_CARD: 'Cartão de Débito',
    CASH: 'Dinheiro',
    BOLETO: 'Boleto',
    OTHER: 'Outro',
  },
  receivedFrom: {
    SYSTEM: 'Sistema',
    EXTERNAL: 'Lançamento manual',
  },
  role: {
    MEMBER: 'Membro',
    LEADER: 'Líder',
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

function isIdField(field: string): boolean {
  return field === 'id' || /Id$/.test(field);
}

/**
 * Rótulo dos campos de vínculo. O valor deles é uuid e não vai para a tela,
 * mas o nome do vínculo precisa aparecer: sem isso, um update que só trocou o
 * desconto de uma inscrição ficava com o conteúdo vazio e a linha inteira se
 * lia como "salvou sem alterar".
 */
const ID_FIELD_LABELS: Record<string, string> = {
  autoBedroomId: 'Quarto automático',
  badgeDeliveredById: 'Entregue por',
  bedroomsId: 'Quarto',
  calledById: 'Chamado por',
  churchId: 'Igreja',
  discountId: 'Desconto',
  doneById: 'Concluído por',
  eventId: 'Evento',
  groupId: 'Grupo',
  groupRoleId: 'Grupo de inscrição',
  newsId: 'Notícia',
  paymentId: 'Pagamento',
  roleRegistrationId: 'Tipo de inscrição',
  teamId: 'Equipe',
  userId: 'Pessoa',
};

/** O uuid não vai para a tela: o que interessa é que o vínculo mudou */
function idFieldState(value: unknown): string {
  return value === null || value === undefined ? '—' : 'definido';
}

function formatValue(
  field: string,
  value: unknown,
  position: 'before' | 'after',
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';

  if (field === 'role' && typeof value === 'number') {
    return ROLE_LABELS[value] ?? String(value);
  }

  if (typeof value === 'string' && ENUM_LABELS[field]?.[value]) {
    return ENUM_LABELS[field][value];
  }

  if ((field === 'amount' || field === 'price') && typeof value === 'number') {
    return currency.format(value);
  }

  if (typeof value === 'string' && ISO_DATE.test(value)) {
    return dateTime.format(new Date(value));
  }

  // Json (payload do pagamento, por exemplo): dizer que mudou é mais útil do
  // que despejar o objeto na tela.
  if (typeof value === 'object') {
    return position === 'before' ? 'conteúdo anterior' : 'conteúdo novo';
  }

  return String(value);
}

function asObject(row: any): Record<string, unknown> | null {
  return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
}

const semCarimbos = (row: any) => {
  if (!row || typeof row !== 'object') return row;
  const copy = { ...row };
  for (const field of ['createdAt', 'updatedAt', 'updateAt']) delete copy[field];
  return JSON.stringify(copy);
};

/**
 * O par de registros que a tela compara.
 *
 * Em operação de lote não serve pegar o índice 0 dos dois lados: num
 * `updateMany` de dez pagamentos o que mudou pode ser o sétimo, e comparar o
 * primeiro devolvia "nada mudou" para uma alteração que existiu. Procura o
 * primeiro par diferente e mostra esse; a contagem de quantos foram atingidos
 * já está na coluna de quem recebeu.
 */
function parComparavel(before: any, after: any) {
  if (Array.isArray(before) && Array.isArray(after)) {
    const indice = before.findIndex(
      (row, i) => semCarimbos(row) !== semCarimbos(after[i]),
    );
    const escolhido = indice >= 0 ? indice : 0;
    return { b: asObject(before[escolhido]), a: asObject(after[escolhido]) };
  }

  const pick = (snapshot: any) =>
    Array.isArray(snapshot) ? asObject(snapshot[0]) : asObject(snapshot);

  return { b: pick(before), a: pick(after) };
}

/**
 * Antes → depois, só do que mudou de fato. Em operação de lote compara o
 * primeiro registro: serve para mostrar *o que* mudou, e a contagem de quantos
 * já está na frase da linha.
 */
export function buildChanges(before: any, after: any): LogChange[] {
  const { b, a } = parComparavel(before, after);
  if (!b && !a) return [];

  const fields = new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]);
  const changes: LogChange[] = [];
  const idChanges: LogChange[] = [];

  for (const field of fields) {
    if (HIDDEN_FIELDS.has(field)) continue;

    const valueBefore = b?.[field] ?? null;
    const valueAfter = a?.[field] ?? null;
    if (JSON.stringify(valueBefore) === JSON.stringify(valueAfter)) continue;

    if (isIdField(field)) {
      idChanges.push({
        field,
        label: ID_FIELD_LABELS[field] ?? field,
        before: idFieldState(valueBefore),
        after: idFieldState(valueAfter),
      });
      continue;
    }

    changes.push({
      field,
      label: FIELD_LABELS[field] ?? field,
      before: formatValue(field, valueBefore, 'before'),
      after: formatValue(field, valueAfter, 'after'),
    });
  }

  // O vínculo só aparece quando é a única coisa que mudou numa edição. Em
  // criação e remoção ele seria ruído: "Pessoa: definido" não acrescenta nada
  // ao que as colunas de tabela e de quem recebeu já dizem.
  const edicao = !!b && !!a;
  if (changes.length === 0 && edicao) return idChanges;

  return changes;
}

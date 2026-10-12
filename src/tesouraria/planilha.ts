/** Sem acento, minúsculo e com um espaço só: "  JÚNIOR  Silva" → "junior silva" */
export const normalizar = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** "Esdras Dantas / Etiene" → "Esdras Dantas": o casal fica com o primeiro nome */
export const nomeDaLinha = (nome: string) => nome.split('/')[0].trim();

/** Conectivos que não identificam ninguém */
const CONECTIVOS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

/**
 * As palavras que identificam a pessoa: sem acento, sem pontuação, sem
 * conectivo e sem inicial solta ("Maria da S Medeiros" → maria, medeiros).
 */
export const palavrasDoNome = (nome: string) =>
  normalizar(nomeDaLinha(nome))
    .split(' ')
    .map((p) => p.replace(/[^a-z0-9]/g, ''))
    .filter((p) => p.length >= 2 && !CONECTIVOS.has(p));

/**
 * As palavras da busca de quem a linha é. Menos de duas ("DJALMA") não
 * busca: com uma palavra em comum, viria gente demais do sistema inteiro.
 */
export function palavrasDaBusca(nome: string): string[] | null {
  const palavras = palavrasDoNome(nome);
  return palavras.length >= 2 ? palavras : null;
}

/**
 * A mesma palavra, ou quase: com 4+ letras, aceita uma letra trocada, a mais
 * ou a menos — "Damares" e "Damaris", "Diogenes" e "Diogenis". Palavra curta
 * precisa ser igual ("Ana" não é "Ina").
 */
export function mesmaPalavra(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) {
    return false;
  }
  // anda junto até a primeira diferença; o resto precisa bater depois de
  // pular uma letra de um lado, do outro ou dos dois
  let i = 0;
  while (a[i] === b[i]) i++;
  return (
    a.slice(i + 1) === b.slice(i + 1) ||
    a.slice(i + 1) === b.slice(i) ||
    a.slice(i) === b.slice(i + 1)
  );
}

/**
 * Quantas palavras os dois nomes têm em comum (palavra inteira, aceitando um
 * erro de digitação). Cada palavra do outro nome casa uma vez só.
 */
export function emComum(a: string, b: string) {
  const deB = palavrasDoNome(b);
  let comuns = 0;
  for (const p of new Set(palavrasDoNome(a))) {
    const i = deB.findIndex((q) => mesmaPalavra(p, q));
    if (i < 0) continue;
    deB.splice(i, 1);
    comuns++;
  }
  return comuns;
}

export interface Candidato {
  id: string;
  fullName: string;
  memberChurchId: string | null;
}

/**
 * Quem a linha da planilha é, entre os candidatos da busca (quem tem 2+
 * palavras do nome em comum). Só escolhe quem pode virar dizimista aqui
 * (membro desta igreja ou de nenhuma):
 *
 * 1. o mesmo nome (as mesmas palavras, sem acento nem conectivo), de
 *    preferência o membro desta igreja quando há homônimos — `exato`;
 * 2. o único em que um nome cabe inteiro no outro, aceitando um erro de
 *    digitação por palavra ("Eduarda Dâmares Lima Diogenes" e "Eduarda
 *    Dâmaris Lima Diógenes"; "Miqueias Sousa" em "Miquéias Abnadabe Ferreira
 *    Sousa") — para conferir;
 * 3. sem nenhum assim, o favorito claro: mesmo primeiro nome, 3+ palavras em
 *    comum e mais que todos os outros — para conferir;
 * 4. senão, a pessoa escolhe.
 */
export function escolher(
  nome: string,
  candidatos: Candidato[],
  churchId: string,
): { escolhido: string | null; exato: boolean } {
  const podem = candidatos.filter(
    (c) => !c.memberChurchId || c.memberChurchId === churchId,
  );
  const alvo = palavrasDoNome(nome);
  const iguais = podem.filter(
    (c) => palavrasDoNome(c.fullName).join(' ') === alvo.join(' '),
  );
  const daqui = iguais.filter((c) => c.memberChurchId === churchId);
  if (daqui.length === 1) return { escolhido: daqui[0].id, exato: true };
  if (iguais.length === 1) return { escolhido: iguais[0].id, exato: true };
  if (iguais.length) return { escolhido: null, exato: false };

  const nota = podem.map((c) => ({
    c,
    comuns: emComum(nome, c.fullName),
    palavras: palavrasDoNome(c.fullName),
  }));
  const cabem = nota.filter(
    (n) =>
      n.comuns >= 2 && n.comuns === Math.min(alvo.length, n.palavras.length),
  );
  if (cabem.length === 1) return { escolhido: cabem[0].c.id, exato: false };
  if (cabem.length) return { escolhido: null, exato: false };

  const [primeiro, segundo] = nota
    .filter((n) => n.comuns >= 3 && mesmaPalavra(alvo[0], n.palavras[0] ?? ''))
    .sort((x, y) => y.comuns - x.comuns);
  return primeiro && (!segundo || primeiro.comuns > segundo.comuns)
    ? { escolhido: primeiro.c.id, exato: false }
    : { escolhido: null, exato: false };
}

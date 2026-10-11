import { FinancialEntryType } from '@prisma/client';

/** O que a sugestão olha em cada lançamento */
export interface ParaConciliar {
  id: string;
  type: FinancialEntryType;
  /** em reais */
  amount: number;
  /** "2026-10-03" */
  date: string;
  userId: string | null;
}

/** Até quantos dias de distância um Pix e o lançamento dele ainda casam */
export const TOLERANCIA_DIAS = 3;

const centavos = (valor: number) => Math.round(valor * 100);
const diasEntre = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
  86_400_000;

/**
 * Sugere pares banco ↔ manual entre os que ainda não estão conciliados: mesmo
 * tipo, mesmo valor ao centavo e datas a até `TOLERANCIA_DIAS` dias — o Pix
 * pode cair no banco um dia depois do lançamento, ou o lançamento ser feito
 * no domingo de um Pix de sábado.
 *
 * Cada lançamento entra em um par só. Quando há mais de um candidato (dois
 * dízimos de R$ 100 na mesma semana), vence o de data mais próxima; no
 * empate, o do mesmo dizimista. É uma sugestão: quem confirma é a pessoa.
 */
export function sugerirPares(
  banco: ParaConciliar[],
  manuais: ParaConciliar[],
  tolerancia = TOLERANCIA_DIAS,
): { bancoId: string; manualId: string }[] {
  const candidatos: { bancoId: string; manualId: string; nota: number }[] = [];
  for (const b of banco) {
    for (const m of manuais) {
      if (b.type !== m.type || centavos(b.amount) !== centavos(m.amount)) {
        continue;
      }
      const dias = diasEntre(b.date, m.date);
      if (dias > tolerancia) continue;
      // o mesmo dizimista desempata, mas não passa na frente de data mais perto
      const mesmoDizimista = b.userId && b.userId === m.userId ? 0.5 : 0;
      candidatos.push({
        bancoId: b.id,
        manualId: m.id,
        nota: dias - mesmoDizimista,
      });
    }
  }

  candidatos.sort((x, y) => x.nota - y.nota);
  const usados = new Set<string>();
  const pares: { bancoId: string; manualId: string }[] = [];
  for (const c of candidatos) {
    if (usados.has(c.bancoId) || usados.has(c.manualId)) continue;
    usados.add(c.bancoId);
    usados.add(c.manualId);
    pares.push({ bancoId: c.bancoId, manualId: c.manualId });
  }
  return pares;
}

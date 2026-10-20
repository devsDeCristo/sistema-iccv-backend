import { randomBytes } from 'crypto';

/**
 * As regras puras do certificado, sem Prisma nem Chrome: o serviço de
 * pagamentos (Minhas Inscrições) usa `eventoTerminou`, e os testes
 * importam daqui sem carregar o puppeteer.
 */

/** Sem 0/O, 1/I/L: o código é lido e digitado por gente */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** "K7P3-QX9M" */
export function novoCodigo(): string {
  const bytes = randomBytes(8);
  const letras = [...bytes].map((b) => ALFABETO[b % ALFABETO.length]);
  return `${letras.slice(0, 4).join('')}-${letras.slice(4).join('')}`;
}

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/**
 * "em 5 de fevereiro de 2027", "de 4 a 7 de fevereiro de 2027" ou "de 30 de
 * janeiro a 2 de fevereiro de 2027". As datas do evento são gravadas à
 * meia-noite UTC, então a leitura é em UTC — como no quadrante.
 */
export function periodoPorExtenso(inicio: Date, fim: Date): string {
  const a = new Date(inicio);
  const b = new Date(fim);
  const dia = (d: Date) => d.getUTCDate();
  const mes = (d: Date) => MESES[d.getUTCMonth()];
  const ano = (d: Date) => d.getUTCFullYear();

  if (ano(a) !== ano(b)) {
    return `de ${dia(a)} de ${mes(a)} de ${ano(a)} a ${dia(b)} de ${mes(
      b,
    )} de ${ano(b)}`;
  }
  if (a.getUTCMonth() !== b.getUTCMonth()) {
    return `de ${dia(a)} de ${mes(a)} a ${dia(b)} de ${mes(b)} de ${ano(b)}`;
  }
  if (dia(a) !== dia(b)) {
    return `de ${dia(a)} a ${dia(b)} de ${mes(b)} de ${ano(b)}`;
  }
  return `em ${dia(a)} de ${mes(a)} de ${ano(a)}`;
}

/** Hoje, por extenso, no horário de Brasília */
export function hojePorExtenso(): string {
  return new Date().toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });
}

/** "05/02 às 08:12", no horário de Brasília */
export function horaDeChegada(data: Date): string {
  const quando = (opcoes: Intl.DateTimeFormatOptions) =>
    data.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...opcoes });
  return `${quando({ day: '2-digit', month: '2-digit' })} às ${quando({
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/** O evento terminou: o último dia já passou inteiro */
export function eventoTerminou(fim: Date, agora = new Date()): boolean {
  return agora.getTime() >= new Date(fim).getTime() + 24 * 60 * 60 * 1000;
}

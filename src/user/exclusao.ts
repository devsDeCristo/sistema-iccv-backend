/** O que a conta tem e impede a exclusão, contado por tipo */
export type HistoricoDaConta = {
  events: number;
  waitlists: number;
  pagamentos: number;
  checkins: number;
  bedrooms: number;
  transports: number;
  TeamOnUsers: number;
  news: number;
};

const NOMES: [keyof HistoricoDaConta, string, string][] = [
  ['events', 'inscrição', 'inscrições'],
  ['waitlists', 'lugar na lista de espera', 'lugares na lista de espera'],
  ['pagamentos', 'pagamento', 'pagamentos'],
  ['checkins', 'check-in', 'check-ins'],
  ['bedrooms', 'quarto', 'quartos'],
  ['transports', 'transporte', 'transportes'],
  ['TeamOnUsers', 'equipe', 'equipes'],
  ['news', 'notícia publicada', 'notícias publicadas'],
];

/**
 * O histórico em frases curtas ("2 inscrições", "1 pagamento"), só do que a
 * conta tem. Vazio quer dizer que ela pode ser excluída.
 */
export function historicoDaConta(contagem: HistoricoDaConta): string[] {
  return NOMES.filter(([chave]) => contagem[chave] > 0).map(
    ([chave, um, varios]) =>
      `${contagem[chave]} ${contagem[chave] === 1 ? um : varios}`,
  );
}

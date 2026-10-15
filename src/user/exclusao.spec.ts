import { historicoDaConta } from './exclusao';

const vazio = {
  events: 0,
  waitlists: 0,
  pagamentos: 0,
  checkins: 0,
  bedrooms: 0,
  transports: 0,
  TeamOnUsers: 0,
  news: 0,
};

describe('historicoDaConta', () => {
  it('conta sem nada pode ser excluída', () => {
    expect(historicoDaConta(vazio)).toEqual([]);
  });

  it('lista só o que a conta tem, no singular e no plural', () => {
    expect(
      historicoDaConta({ ...vazio, events: 2, pagamentos: 1, news: 3 }),
    ).toEqual(['2 inscrições', '1 pagamento', '3 notícias publicadas']);
  });
});

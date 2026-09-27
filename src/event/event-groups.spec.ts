import { BadRequestException } from '@nestjs/common';
import { grupoFechado, janelaRecebida } from './event-groups';

const grupo = (janela: Partial<Parameters<typeof grupoFechado>[0]> = {}) => ({
  name: 'Jovens',
  active: true,
  opensAt: null,
  closesAt: null,
  ...janela,
});

// 12/10 às 08:00 em Brasília
const abertura = new Date('2026-10-12T11:00:00.000Z');
const encerramento = new Date('2026-10-20T02:59:00.000Z');

describe('grupoFechado', () => {
  it('ativo e sem datas recebe sempre', () => {
    expect(grupoFechado(grupo())).toBeNull();
  });

  it('desligado não recebe, com ou sem data', () => {
    expect(grupoFechado(grupo({ active: false }))).toBe(
      'O grupo "Jovens" não está recebendo inscrições',
    );
    expect(
      grupoFechado(grupo({ active: false, opensAt: abertura }), encerramento),
    ).not.toBeNull();
  });

  it('agendado abre no segundo marcado, no horário de Brasília', () => {
    const agendado = grupo({ opensAt: abertura });
    expect(grupoFechado(agendado, new Date(abertura.getTime() - 1000))).toBe(
      'As inscrições do grupo "Jovens" abrem em 12/10 às 08:00',
    );
    expect(grupoFechado(agendado, abertura)).toBeNull();
  });

  it('encerra no horário marcado', () => {
    const lote = grupo({ opensAt: abertura, closesAt: encerramento });
    expect(
      grupoFechado(lote, new Date(encerramento.getTime() - 1000)),
    ).toBeNull();
    expect(grupoFechado(lote, encerramento)).toBe(
      'As inscrições do grupo "Jovens" encerraram em 19/10 às 23:59',
    );
  });
});

describe('grupoFechado — fim do evento', () => {
  const fimDoEvento = new Date('2026-10-12T21:00:00.000Z');

  it('sem data no grupo, encerra no fim do evento', () => {
    expect(
      grupoFechado(
        grupo(),
        new Date(fimDoEvento.getTime() - 1000),
        fimDoEvento,
      ),
    ).toBeNull();
    expect(grupoFechado(grupo(), fimDoEvento, fimDoEvento)).toBe(
      'As inscrições do grupo "Jovens" encerraram em 12/10 às 18:00',
    );
  });

  it('a data do grupo manda, mesmo depois do fim do evento', () => {
    const depois = new Date(fimDoEvento.getTime() + 86400000);
    expect(
      grupoFechado(grupo({ closesAt: depois }), fimDoEvento, fimDoEvento),
    ).toBeNull();
  });
});

describe('janelaRecebida', () => {
  it('ausente não mexe; vazio apaga a data', () => {
    expect(janelaRecebida({ name: 'Jovens' })).toEqual({
      active: undefined,
      opensAt: undefined,
      closesAt: undefined,
    });
    expect(
      janelaRecebida({
        name: 'Jovens',
        active: false,
        opensAt: '',
        closesAt: null,
      }),
    ).toEqual({ active: false, opensAt: null, closesAt: null });
  });

  it('recusa encerrar antes de abrir', () => {
    expect(() =>
      janelaRecebida({
        name: 'Jovens',
        opensAt: encerramento.toISOString(),
        closesAt: abertura.toISOString(),
      }),
    ).toThrow(BadRequestException);
  });
});

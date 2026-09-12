import { PaymentStatus } from '@prisma/client';
import { conferirValorPago } from './amount-check';

/**
 * A conferência que separa "a casa disse que pagou" de "o dinheiro entrou".
 *
 * Ela existe por causa da InfinitePay, cuja API de checkout não tem
 * autenticação: quem soubesse a referência da própria inscrição criava um link
 * de um centavo com ela e a cobrança de R$ 300 passava a responder "pago".
 */
describe('conferirValorPago', () => {
  const COBRADO = 30000; // R$ 300,00

  it('confirma quando o valor bate', () => {
    expect(conferirValorPago(PaymentStatus.PAID, COBRADO, COBRADO, 'ref')).toBe(
      PaymentStatus.PAID,
    );
  });

  it('manda para análise quando pagaram a menos', () => {
    // O ataque: R$ 0,01 numa cobrança de R$ 300.
    expect(conferirValorPago(PaymentStatus.PAID, 1, COBRADO, 'ref')).toBe(
      PaymentStatus.IN_ANALYSIS,
    );
  });

  it('manda para análise mesmo faltando um centavo', () => {
    expect(
      conferirValorPago(PaymentStatus.PAID, COBRADO - 1, COBRADO, 'ref'),
    ).toBe(PaymentStatus.IN_ANALYSIS);
  });

  it('confirma quem pagou a mais', () => {
    // Sobra é acerto de caixa. Travar a inscrição de quem pagou demais seria o
    // pior dos dois erros.
    expect(
      conferirValorPago(PaymentStatus.PAID, COBRADO + 500, COBRADO, 'ref'),
    ).toBe(PaymentStatus.PAID);
  });

  it('não mexe em status que não é pago', () => {
    // Uma cobrança recusada não vira "em análise" por causa do valor.
    expect(conferirValorPago(PaymentStatus.DECLINED, 1, COBRADO)).toBe(
      PaymentStatus.DECLINED,
    );
    expect(conferirValorPago(PaymentStatus.REFUNDED, 1, COBRADO)).toBe(
      PaymentStatus.REFUNDED,
    );
  });

  describe('quando não há com o que comparar', () => {
    it('deixa passar o checkout anterior à coluna', () => {
      // O valor enviado não foi guardado e não dá para reconstruí-lo. Recusar
      // tudo o que é antigo derrubaria pagamento legítimo em curso.
      expect(conferirValorPago(PaymentStatus.PAID, 1, null, 'ref')).toBe(
        PaymentStatus.PAID,
      );
      expect(conferirValorPago(PaymentStatus.PAID, 1, undefined)).toBe(
        PaymentStatus.PAID,
      );
    });

    it('deixa passar a casa que não informa quanto entrou', () => {
      expect(conferirValorPago(PaymentStatus.PAID, null, COBRADO)).toBe(
        PaymentStatus.PAID,
      );
      expect(conferirValorPago(PaymentStatus.PAID, undefined, COBRADO)).toBe(
        PaymentStatus.PAID,
      );
    });

    it('não confunde zero pago com ausência de informação', () => {
      // `0` é falsy: um `if (!pago)` aqui deixaria passar justamente a
      // cobrança que não recebeu nada.
      expect(conferirValorPago(PaymentStatus.PAID, 0, COBRADO, 'ref')).toBe(
        PaymentStatus.IN_ANALYSIS,
      );
    });
  });
});

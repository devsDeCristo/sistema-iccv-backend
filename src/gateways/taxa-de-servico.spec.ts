import { BadRequestException } from '@nestjs/common';
import { PaymentProviderService } from '../payment-providers/payment-provider.service';
import {
  lerTaxas,
  taxaDeServicoEmCentavos,
  taxasDeServico,
} from './core/opcoes-de-pagamento';
import { MercadoPagoGateway } from './mercadopago/mercadopago.gateway';
import { InfinitePayGateway } from './infinitepay/infinitepay.gateway';

/**
 * Repassar a taxa do gateway ao inscrito: a igreja recebe o valor cheio, e o
 * inscrito paga a taxa de serviço junto.
 */
describe('Taxa de serviço', () => {
  const mp = new MercadoPagoGateway({} as any).descriptor.fields;
  const taxasMp = 'PIX=0.99,BOLETO=3.99,CREDIT_CARD=4.98,DEBIT_CARD=3.99';

  it('a conta é por divisão: a igreja recebe o cheio depois da taxa', () => {
    // 120 ÷ (1 − 4,98%) = 126,29; somar 4,98% daria 126,00
    expect(taxaDeServicoEmCentavos(12000, 4.98)).toBe(629);
    expect(taxaDeServicoEmCentavos(12000, 0)).toBe(0);
    expect(taxaDeServicoEmCentavos(0, 4.98)).toBe(0);
  });

  it('lê o gravado e descarta o que não é percentual', () => {
    expect(lerTaxas('PIX=0.99,CREDIT_CARD=4.98')).toEqual({
      PIX: 0.99,
      CREDIT_CARD: 4.98,
    });
    expect(lerTaxas('PIX=abc,BOLETO=150')).toEqual({});
    expect(lerTaxas(undefined)).toEqual({});
  });

  it('sem repasse não há taxa', () => {
    expect(taxasDeServico(mp, {})).toBeNull();
  });

  it('Pix na tela tem a dele; o checkout, a maior das formas que ficam lá', () => {
    expect(taxasDeServico(mp, { serviceFees: taxasMp })).toEqual({
      pix: 0.99,
      checkout: 4.98,
    });
  });

  it('só boleto no checkout: vale a do boleto, e não a do cartão', () => {
    expect(
      taxasDeServico(mp, {
        serviceFees: taxasMp,
        enabledMethods: 'PIX,BOLETO',
      }),
    ).toEqual({ pix: 0.99, checkout: 3.99 });
  });

  it('sem Pix ligado, nada é pago na tela: o checkout leva tudo', () => {
    expect(
      taxasDeServico(mp, {
        serviceFees: taxasMp,
        enabledMethods: 'BOLETO,CREDIT_CARD',
      }),
    ).toEqual({ pix: null, checkout: 4.98 });
  });

  it('gateway sem escolha de formas (InfinitePay): a maior de todas', () => {
    const ip = new InfinitePayGateway({} as any).descriptor.fields;
    expect(
      taxasDeServico(ip, { serviceFees: 'PIX=0,CREDIT_CARD=5.49' }),
    ).toEqual({ pix: null, checkout: 5.49 });
  });

  describe('o salvar só aceita percentual válido de forma da integração', () => {
    const validar = (valor: string) =>
      (PaymentProviderService.prototype as any).validarCampos.call(
        {},
        mp,
        { serviceFees: valor },
        // token e assinatura já gravados: é uma edição
        { accessToken: 't', webhookSecret: 's' },
      );

    it('aceita de 0 a 99,99, com até duas casas', () => {
      expect(validar('PIX=0,CREDIT_CARD=4.98').serviceFees).toBe(
        'PIX=0,CREDIT_CARD=4.98',
      );
    });

    it.each([
      ['forma que o gateway não tem', 'WALLET=1'],
      ['acima de 99,99', 'PIX=100'],
      ['três casas', 'PIX=1.234'],
      ['negativo', 'PIX=-1'],
      ['forma repetida', 'PIX=1,PIX=2'],
    ])('recusa %s', (_, valor) => {
      expect(() => validar(valor)).toThrow(BadRequestException);
    });
  });
});

import { PaymentMethod, PaymentProvider } from '@prisma/client';
import {
  formasEscolhidas,
  parcelasEscolhidas,
} from './core/opcoes-de-pagamento';
import { MercadoPagoGateway } from './mercadopago/mercadopago.gateway';
import { PagbankGateway } from './pagbank/pagbank.gateway';
import { TonGateway } from './ton/ton.gateway';

/**
 * A etapa "Pagamento" do cadastro: as formas e o teto de parcelas escolhidos
 * pela igreja precisam chegar no corpo da cobrança de cada gateway.
 */
describe('Formas de pagamento e parcelas', () => {
  const pedido: any = {
    referenceId: 'ref-1',
    eventId: 'ev-1',
    eventName: 'Retiro',
    customer: {
      name: 'Ana Souza',
      email: 'ana@x.com',
      taxId: '12345678909',
      phone: { country: '55', area: '71', number: '999999999' },
    },
    items: [
      {
        referenceId: 'i-1',
        name: 'Inscrição',
        quantity: 1,
        unitAmountCents: 12000,
      },
    ],
    discountCents: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    paymentNotificationUrl: 'https://api/x',
    checkoutNotificationUrl: 'https://api/y',
    redirectUrl: 'https://site/z',
    softDescriptor: 'IGREJA',
  };

  const ctx = (provider: PaymentProvider, credentials: object): any => ({
    churchId: 'igreja-1',
    configId: 'cfg-1',
    provider,
    mode: 'PRODUCTION',
    credentials: {
      accessToken: 't',
      token: 't',
      secretKey: 's',
      ...credentials,
    },
  });

  /** Um cliente que só guarda o corpo que receberia */
  function cliente(metodo: string) {
    const enviado: any = {};
    return {
      enviado,
      [metodo]: async (corpo: any) => {
        enviado.corpo = corpo;
        return { id: 'x', init_point: 'u', links: [], checkouts: [{}] };
      },
    } as any;
  }

  it('nada escolhido é todas; o escolhido vem na ordem do gateway', () => {
    const todas = [PaymentMethod.CREDIT_CARD, PaymentMethod.PIX];
    expect(formasEscolhidas(undefined, todas)).toEqual(todas);
    expect(formasEscolhidas('PIX,CREDIT_CARD', todas)).toEqual(todas);
    expect(formasEscolhidas('PIX', todas)).toEqual([PaymentMethod.PIX]);
  });

  it('parcelas: ausente é padrão do gateway; acima do teto vira o teto', () => {
    expect(parcelasEscolhidas(undefined, 12)).toBeNull();
    expect(parcelasEscolhidas('abc', 12)).toBeNull();
    expect(parcelasEscolhidas('6', 12)).toBe(6);
    expect(parcelasEscolhidas('30', 12)).toBe(12);
  });

  it('Mercado Pago exclui o que a igreja desmarcou e limita as parcelas', async () => {
    const c = cliente('createPreference');
    await new MercadoPagoGateway(c).createCheckout(
      pedido,
      ctx(PaymentProvider.MERCADO_PAGO, {
        enabledMethods: 'PIX,CREDIT_CARD',
        maxInstallments: '6',
      }),
    );

    // o Pix ligado é pago na nossa tela, e sai do checkout junto das desmarcadas
    expect(c.enviado.corpo.payment_methods).toEqual({
      excluded_payment_types: [
        { id: 'bank_transfer' },
        { id: 'ticket' },
        { id: 'debit_card' },
      ],
      installments: 6,
    });
  });

  it('Mercado Pago sem escolha só tira o Pix (vai para a nossa tela) e não limita', async () => {
    const c = cliente('createPreference');
    await new MercadoPagoGateway(c).createCheckout(
      pedido,
      ctx(PaymentProvider.MERCADO_PAGO, {}),
    );

    expect(c.enviado.corpo.payment_methods).toEqual({
      excluded_payment_types: [{ id: 'bank_transfer' }],
    });
  });

  it('PagBank manda só as escolhidas e o limite de parcelas do crédito', async () => {
    const c = cliente('createCheckout');
    await new PagbankGateway(c).createCheckout(
      pedido,
      ctx(PaymentProvider.PAGBANK, {
        enabledMethods: 'CREDIT_CARD,PIX',
        maxInstallments: '3',
      }),
    );

    // o Pix ligado é pago na nossa tela: no checkout fica só o crédito
    expect(c.enviado.corpo.payment_methods).toEqual([{ type: 'CREDIT_CARD' }]);
    expect(c.enviado.corpo.payment_methods_configs).toEqual([
      {
        type: 'CREDIT_CARD',
        config_options: [{ option: 'INSTALLMENTS_LIMIT', value: '3' }],
      },
    ]);
  });

  it('PagBank sem crédito não manda limite de parcelas', async () => {
    const c = cliente('createCheckout');
    await new PagbankGateway(c).createCheckout(
      pedido,
      ctx(PaymentProvider.PAGBANK, {
        enabledMethods: 'BOLETO',
        maxInstallments: '3',
      }),
    );

    expect(c.enviado.corpo.payment_methods).toEqual([{ type: 'BOLETO' }]);
    expect(c.enviado.corpo.payment_methods_configs).toBeUndefined();
  });

  it('Ton sem Pix troca a forma padrão para uma aceita', async () => {
    const c = cliente('createOrder');
    await new TonGateway(c).createCheckout(
      pedido,
      ctx(PaymentProvider.TON, { enabledMethods: 'CREDIT_CARD,BOLETO' }),
    );

    const checkout = c.enviado.corpo.payments[0].checkout;
    expect(checkout.accepted_payment_methods).toEqual([
      'credit_card',
      'boleto',
    ]);
    expect(checkout.default_payment_method).toBe('credit_card');
  });

  it('Ton sem cartão não manda o bloco de cartão; sem Pix, nem o de Pix', async () => {
    const c = cliente('createOrder');
    await new TonGateway(c).createCheckout(
      pedido,
      ctx(PaymentProvider.TON, { enabledMethods: 'BOLETO' }),
    );

    const checkout = c.enviado.corpo.payments[0].checkout;
    expect(checkout.accepted_payment_methods).toEqual(['boleto']);
    expect(checkout.default_payment_method).toBe('boleto');
    expect(checkout.credit_card).toBeUndefined();
    expect(checkout.pix).toBeUndefined();
  });
});

import { BadRequestException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
} from '@prisma/client';
import { PaymentProviderService } from '../payment-providers/payment-provider.service';
import { GatewayResourceNotFoundError } from './core/gateway.errors';
import { GatewayContext, HostedCheckoutRequest } from './core/gateway.types';
import { taxasDeServico } from './core/opcoes-de-pagamento';
import {
  brCodeValido,
  crcDoBrCode,
  ehPixEstatico,
  identificadorDoPix,
  limparBrCode,
  mesmaChave,
  pixEstaticoComValor,
  problemaNoPixEstatico,
  repararBrCode,
} from './core/pix-estatico';
import { PayPalGateway } from './paypal/paypal.gateway';

/** O exemplo do manual do BR Code do Banco Central */
const CODIGO =
  '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

/**
 * Pix estático no PayPal: o QR é o código colado na configuração, o PayPal
 * não é chamado, e a baixa fica com quem administra.
 */
describe('Pix estático', () => {
  /** Monta um BR Code com o CRC certo a partir dos campos */
  const montar = (...campos: [string, string][]) => {
    const corpo =
      campos
        .map(([id, v]) => `${id}${String(v.length).padStart(2, '0')}${v}`)
        .join('') + '6304';
    return corpo + crcDoBrCode(corpo);
  };
  const conta = (sub: [string, string][]) =>
    sub
      .map(([id, v]) => `${id}${String(v.length).padStart(2, '0')}${v}`)
      .join('');
  const base: [string, string][] = [
    ['00', '01'],
    [
      '26',
      conta([
        ['00', 'br.gov.bcb.pix'],
        ['01', '+5555999219342'],
      ]),
    ],
    ['52', '0000'],
    ['53', '986'],
    ['58', 'BR'],
    ['59', 'IGREJA'],
    ['60', 'SAO PAULO'],
    ['62', conta([['05', '***']])],
  ];

  it('aceita o código da chave, sem valor', () => {
    expect(problemaNoPixEstatico(montar(...base))).toBeNull();
    expect(
      problemaNoPixEstatico(montar(base[0], ['01', '11'], ...base.slice(1))),
    ).toBeNull();
  });

  it('recusa valor fixo: cobraria o mesmo de todo mundo', () => {
    const comValor = montar(
      ...base.slice(0, 4),
      ['54', '10.00'],
      ...base.slice(4),
    );
    expect(problemaNoPixEstatico(comValor)).toMatch(/valor fixo/);
  });

  it('recusa Pix de cobrança (dinâmico): é de uso único', () => {
    const porUrl = montar(
      base[0],
      [
        '26',
        conta([
          ['00', 'br.gov.bcb.pix'],
          ['25', 'pix.banco.com/qr/v2/abc'],
        ]),
      ],
      ...base.slice(2),
    );
    expect(problemaNoPixEstatico(porUrl)).toMatch(/cobrança/);
    expect(
      problemaNoPixEstatico(montar(base[0], ['01', '12'], ...base.slice(1))),
    ).toMatch(/cobrança/);
  });

  it('recusa o que não é Pix, mesmo com o CRC certo', () => {
    const outro = montar(
      base[0],
      [
        '26',
        conta([
          ['00', 'br.com.outro'],
          ['01', 'x'],
        ]),
      ],
      ...base.slice(2),
    );
    expect(problemaNoPixEstatico(outro)).toMatch(/não é de Pix/);
  });

  it('diz o que está errado, e não só que está errado', () => {
    expect(problemaNoPixEstatico('igreja@exemplo.org')).toMatch(
      /é a chave Pix, não o código/,
    );
    expect(problemaNoPixEstatico('+55 55 99921-9342')).toMatch(/é a chave Pix/);
    expect(problemaNoPixEstatico('br.gov.bcb.pix0114+555599')).toMatch(
      /precisa começar com 000201, e este começa com "br.gov"/,
    );
    expect(problemaNoPixEstatico(CODIGO.slice(0, -6))).toMatch(
      /final do código está faltando/,
    );
    expect(
      problemaNoPixEstatico(CODIGO.replace('BRASILIA', 'BRASILA')),
    ).toMatch(/parte faltando no meio .*"1D3D" não confere/);
    // o final certo não é dito: daria para "consertar" um código mutilado
    expect(
      problemaNoPixEstatico(CODIGO.replace('BRASILIA', 'BRASILA')),
    ).not.toMatch(/seria/);
  });

  it('copiado de PDF: tira o espaço inventado e mantém o de verdade', () => {
    const real =
      '00020101021126360014br.gov.bcb.pix0114+55559992193425204000053039865802BR5904CNIC6009SAO PAULO622905253vGFeh9O8CijzPhdilT12iSPc6304F071';
    // o caso da tela: o PDF quebrava a linha entre "CNI" e "C"
    const doPdf = real.replace('5904CNIC', '5904CNI C');
    expect(problemaNoPixEstatico(doPdf)).toMatch(/não confere/);
    expect(repararBrCode(doPdf)).toBe(real);
    // dois espaços inventados, e o de "SAO PAULO" fica
    const doisCortes = doPdf.replace('br.gov.bcb.pix', 'br.gov. bcb.pix');
    expect(repararBrCode(doisCortes)).toBe(real);
    // o que já fecha não muda; o que não tem conserto volta como veio
    expect(repararBrCode(real)).toBe(real);
    const cortado = real.slice(0, 50) + ' ' + real.slice(60);
    expect(repararBrCode(cortado)).toBe(cortado);
  });

  it('o salvar conserta o código do PDF e grava o certo', () => {
    const real =
      '00020101021126360014br.gov.bcb.pix0114+55559992193425204000053039865802BR5904CNIC6009SAO PAULO622905253vGFeh9O8CijzPhdilT12iSPc6304F071';
    const gravado = (
      PaymentProviderService.prototype as any
    ).validarCampos.call(
      {},
      paypal.descriptor.fields,
      {
        clientId: 'cid',
        staticPixCode: real.replace('5904CNIC', '5904CNI C'),
      },
      { clientSecret: 'sec' },
    );
    expect(gravado.staticPixCode).toBe(real);
  });

  it('o espaço "especial" de quem copiou vira o comum', () => {
    const copiado = CODIGO.replace('Fulano de Tal', 'Fulano\u00a0de\u00a0Tal');
    expect(problemaNoPixEstatico(copiado)).not.toBeNull();
    expect(problemaNoPixEstatico(limparBrCode(copiado))).toBeNull();
  });

  it('aceita só o BR Code inteiro, com o CRC certo', () => {
    expect(brCodeValido(CODIGO)).toBe(true);
    expect(brCodeValido(CODIGO.replace('Fulano', 'Ciclano'))).toBe(false);
    expect(brCodeValido(CODIGO.slice(0, 60))).toBe(false);
    expect(brCodeValido('minha-chave@igreja.org')).toBe(false);
  });

  const client = { createOrder: jest.fn(), getOrder: jest.fn() };
  const paypal = new PayPalGateway(client as any);
  const ctx: GatewayContext = {
    churchId: 'ig-1',
    configId: 'config-1',
    provider: PaymentProvider.PAYPAL,
    mode: PaymentProviderMode.PRODUCTION,
    credentials: {
      clientId: 'cid',
      clientSecret: 'sec',
      enabledMethods: 'PIX,CREDIT_CARD',
      serviceFees: 'PIX=0.99,CREDIT_CARD=4.79',
      staticPixCode: CODIGO,
    },
  };
  const pedido = {
    referenceId: 'ref-1',
    eventName: 'Retiro',
    softDescriptor: 'Igreja de cristo',
    redirectUrl: 'https://front/eventos/ev-1',
    customer: {
      name: 'Fulano de Tal',
      email: 'f@x.com',
      taxId: '12345678909',
      phone: { country: '55', area: '55', number: '991234567' },
    },
    paymentMethod: PaymentMethod.PIX,
    expiresAt: new Date('2026-11-26T13:00:00Z'),
    items: [
      {
        referenceId: 'a',
        name: 'Ingresso',
        quantity: 1,
        unitAmountCents: 10000,
      },
    ],
    discountCents: 0,
  } as unknown as HostedCheckoutRequest;

  it('mostra a chave colada com o valor e o identificador, sem pedido no PayPal', async () => {
    const r = await paypal.createCheckout(pedido, ctx);

    expect(client.createOrder).not.toHaveBeenCalled();
    expect(ehPixEstatico(r.checkoutId)).toBe(true);
    expect(r.pix?.expiresAt).toBe(pedido.expiresAt);
    // o mesmo recebedor, agora com R$ 100,00 e o identificador do inscrito
    expect(mesmaChave(r.pix?.code, CODIGO)).toBe(true);
    expect(r.pix?.code).toContain('540610' + '0.00');
    expect(r.pix?.code).toContain('FULANODETALREF1');
    expect(r.pix?.code.slice(-4)).toBe(crcDoBrCode(r.pix!.code.slice(0, -4)));
  });

  it('o código com valor: CRC refeito, chave e recebedor intactos', () => {
    const comValor = pixEstaticoComValor(CODIGO, 25000, 'TAILANDAROSA3F9A');

    expect(comValor.slice(-4)).toBe(crcDoBrCode(comValor.slice(0, -4)));
    expect(comValor).toContain('5406250.00');
    // o identificador entra no lugar do *** do adicional (62 / 05)
    expect(comValor).toContain('0516TAILANDAROSA3F9A');
    expect(comValor).not.toContain('***');
    expect(comValor).toContain('0136123e4567-e12b-12d1-a456-426655440000');
    expect(comValor).toContain('5913Fulano de Tal6008BRASILIA');
    // com valor, deixa de servir de código da chave — e nunca é o que se cola
    expect(problemaNoPixEstatico(comValor)).toMatch(/valor fixo/);
  });

  it('identificador: só letras e números, até 25, nome sem acento', () => {
    expect(identificadorDoPix('Tailan da Rosa', '3f9a2b1c-aaaa')).toBe(
      'TAILANDAROSA3F9A',
    );
    expect(
      identificadorDoPix('Maria José de Souza Albuquerque Neto', 'ab-cd'),
    ).toBe('MARIAJOSEDESOUZAALBUQABCD');
  });

  it('mesmaChave ignora valor e identificador, e não confunde chaves', () => {
    const outra = CODIGO.replace('Fulano de Tal', 'Ciclano de T');
    expect(mesmaChave(pixEstaticoComValor(CODIGO, 100, 'X'), CODIGO)).toBe(
      true,
    );
    expect(mesmaChave(outra, CODIGO)).toBe(false);
    expect(mesmaChave(null, CODIGO)).toBe(false);
  });

  it('cartão continua indo para o PayPal', async () => {
    client.createOrder.mockResolvedValueOnce({ id: 'ORDER-1', links: [] });
    await paypal.createCheckout(
      { ...pedido, paymentMethod: PaymentMethod.CREDIT_CARD },
      ctx,
    );
    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });

  it('conferir não pergunta ao PayPal: segue aguardando a baixa manual', async () => {
    const r = await paypal.createCheckout(pedido, ctx);
    await expect(
      paypal.listCharges('ref-1', ctx, r.checkoutId),
    ).rejects.toBeInstanceOf(GatewayResourceNotFoundError);
    expect(client.getOrder).not.toHaveBeenCalled();
  });

  it('sem custo de gateway, o Pix não leva taxa de serviço', () => {
    expect(taxasDeServico(paypal.descriptor.fields, ctx.credentials)).toEqual({
      pix: 0,
      checkout: 4.79,
    });
  });

  it('o salvar recusa código cortado ou que não é BR Code', () => {
    const validar = (codigo: string) =>
      (PaymentProviderService.prototype as any).validarCampos.call(
        {},
        paypal.descriptor.fields,
        { clientId: 'cid', staticPixCode: codigo },
        { clientSecret: 'sec' },
      );

    expect(validar(CODIGO).staticPixCode).toBe(CODIGO);
    // colado de mensagem: quebrado em linhas e com espaço invisível
    expect(
      validar(`\u200B${CODIGO.slice(0, 40)}\r\n${CODIGO.slice(40)}\n`)
        .staticPixCode,
    ).toBe(CODIGO);
    expect(() => validar(CODIGO.slice(0, -1))).toThrow(BadRequestException);
    expect(() => validar('chave@igreja.org')).toThrow(BadRequestException);
  });
});

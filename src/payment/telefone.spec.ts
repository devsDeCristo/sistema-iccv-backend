import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';

/** O celular do cadastro vira DDD + número para o gateway */
describe('DDD e número do celular', () => {
  const extrair = (telefone: string | null) =>
    (PaymentService.prototype as any).extrairDddENumero(telefone);

  it.each([
    ['(55) 99123-4567', '55', '991234567'], // DDD 55 do RS, não o país
    ['55 3222-1234', '55', '32221234'],
    ['+55 55 99123-4567', '55', '991234567'],
    ['+55 (11) 98765-4321', '11', '987654321'],
    ['011 98765-4321', '11', '987654321'],
  ])('%s', (telefone, ddd, numero) => {
    expect(extrair(telefone)).toEqual({ ddd, numero });
  });

  it.each([null, '', '9912-3456', '1234567890123'])(
    'recusa %p com 400, e não 500',
    (telefone) => {
      expect(() => extrair(telefone)).toThrow(BadRequestException);
    },
  );
});

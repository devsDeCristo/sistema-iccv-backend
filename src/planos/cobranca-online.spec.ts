import { ChurchModule } from '@prisma/client';
import { cobraOnline } from './modulos';

/**
 * A igreja cobra pelo site com o módulo Eventos no plano **e** a cobrança
 * ligada nela (`modulePayment`, que o dev/super admin desliga por igreja).
 */
describe('cobraOnline', () => {
  const comEventos = { plan: { modules: [ChurchModule.EVENTS] } };

  it('Eventos no plano e cobrança ligada (ou sem o campo): cobra', () => {
    expect(cobraOnline({ ...comEventos, modulePayment: true })).toBe(true);
    expect(cobraOnline(comEventos)).toBe(true);
  });

  it('cobrança desligada na igreja: não cobra, mesmo com Eventos', () => {
    expect(cobraOnline({ ...comEventos, modulePayment: false })).toBe(false);
  });

  it('sem Eventos no plano (ou sem plano): não cobra, mesmo ligada', () => {
    expect(
      cobraOnline({
        plan: { modules: [ChurchModule.NEWS] },
        modulePayment: true,
      }),
    ).toBe(false);
    expect(cobraOnline({ plan: null, modulePayment: true })).toBe(false);
  });
});

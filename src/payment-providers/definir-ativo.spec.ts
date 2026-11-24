import { ForbiddenException } from '@nestjs/common';
import { PaymentProvider, PaymentProviderMode } from '@prisma/client';
import { PaymentProviderService } from './payment-provider.service';

/** A chave do card: só uma integração cobra por vez. */
describe('Ligar e desligar pelo card', () => {
  function montar(
    isDefault: boolean,
    mode: PaymentProviderMode = PaymentProviderMode.PRODUCTION,
  ) {
    const gravado: any = {
      id: 'cfg-1',
      churchId: 'igreja-1',
      provider: PaymentProvider.PAGBANK,
      enabled: isDefault,
      isDefault,
      mode,
    };
    const demais: any[] = [];
    const tx = {
      paymentProviderConfig: {
        update: async ({ data }: any) => Object.assign(gravado, data),
        updateMany: async (args: any) => demais.push(args),
      },
    };
    const prisma = {
      paymentProviderConfig: { findUnique: async () => ({ ...gravado }) },
      $transaction: (fn: any) => fn(tx),
      user: { findUnique: async () => ({ role: 'ADMIN' }) },
    };
    const registry = {
      descriptor: () => ({ webhookChannels: [] }),
      segredoDeWebhook: () => 'segredo',
    };

    const service = new PaymentProviderService(
      prisma as any,
      registry as any,
      { disponivel: true, decifrar: () => ({}) } as any,
    );
    return { service, demais };
  }

  it('ligar torna esta a que cobra e desliga as demais', async () => {
    const { service, demais } = montar(false);

    const r = await service.definirAtivo(
      'igreja-1',
      PaymentProvider.PAGBANK,
      true,
    );

    expect(r).toMatchObject({ enabled: true, isDefault: true });
    expect(demais).toEqual([
      {
        where: { churchId: 'igreja-1', provider: { not: 'PAGBANK' } },
        data: { isDefault: false, enabled: false },
      },
    ]);
  });

  it('desligar tira o padrão e não mexe nas demais', async () => {
    const { service, demais } = montar(true);

    const r = await service.definirAtivo(
      'igreja-1',
      PaymentProvider.PAGBANK,
      false,
    );

    expect(r).toMatchObject({ enabled: false, isDefault: false });
    expect(demais).toEqual([]);
  });

  it('admin não liga integração em sandbox', async () => {
    const { service, demais } = montar(false, PaymentProviderMode.SANDBOX);

    await expect(
      service.definirAtivo('igreja-1', PaymentProvider.PAGBANK, true, 'u-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(demais).toEqual([]);
  });
});

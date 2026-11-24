import { BadRequestException } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import { SecretCryptoService } from 'src/crypto/secret-crypto.service';
import {
  CHAVE_DO_WEBHOOK,
  contextoDoSelo,
} from 'src/gateways/core/payment-gateway.registry';
import { PaymentProviderService } from './payment-provider.service';

/**
 * A URL mostrada no cadastro precisa ser a mesma que a integração recebe ao
 * salvar: é ela que a pessoa já colou no painel do gateway.
 */
describe('URL de notificação no cadastro', () => {
  const MP = PaymentProvider.MERCADO_PAGO;

  function montar() {
    process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString(
      'base64',
    );
    const crypto = new SecretCryptoService();

    const registry = {
      descriptor: () => ({
        fields: [
          {
            key: 'accessToken',
            label: 'Access token',
            required: true,
            secret: true,
          },
        ],
        webhookChannels: [{ key: 'payments', label: 'Pagamento' }],
      }),
      segredoDeWebhook: (config: any) =>
        crypto.decifrar<Record<string, string>>(
          config.credentials,
          contextoDoSelo(config.churchId, config.provider),
        )[CHAVE_DO_WEBHOOK],
    };

    let salvo: any = null;
    const tx = {
      paymentProviderConfig: {
        upsert: async ({ create }: any) =>
          (salvo = { ...create, isDefault: false }),
        updateMany: async () => ({}),
        update: async () => salvo,
      },
    };
    const prisma = {
      paymentProviderConfig: { findUnique: async () => null },
      $transaction: (fn: any) => fn(tx),
    };

    return new PaymentProviderService(prisma as any, registry as any, crypto);
  }

  it('o primeiro salvar adota a URL gerada no cadastro', async () => {
    const service = montar();

    const rascunho = await service.rascunhoDeWebhook('igreja-1', MP);
    const salvo = await service.salvar('igreja-1', MP, {
      credentials: { accessToken: 'APP_USR-x' },
      webhookDraft: rascunho.webhookDraft!,
    });

    expect(salvo.webhooks[0].url).toBe(rascunho.webhooks[0].url);
  });

  it('rascunho de outra igreja é recusado', async () => {
    const service = montar();

    const rascunho = await service.rascunhoDeWebhook('igreja-1', MP);

    await expect(
      service.salvar('igreja-2', MP, {
        credentials: { accessToken: 'APP_USR-x' },
        webhookDraft: rascunho.webhookDraft!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

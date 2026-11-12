import { CheckoutStatus, PaymentProvider } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { GatewayResourceNotFoundError } from 'src/gateways/core/gateway.errors';
import { CronService } from './cron.service';

/**
 * Pedido que o gateway não conhece mais (o do PayPal some da API quando
 * expira) não pode ser perguntado de novo a cada 3 horas, para sempre.
 */
describe('reconciliação — pedido que o gateway não conhece', () => {
  const HORA = 60 * 60 * 1000;

  const montar = (criadoHa: number) => {
    const updateMany = jest.fn();
    const banco = {
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            eventId: null,
            checkouts: [
              {
                referenceId: 'ref-1',
                checkoutId: 'ORDER-1',
                provider: PaymentProvider.PAYPAL,
                configId: 'config-1',
                chargedAmountCents: 1000,
                createdAt: new Date(Date.now() - criadoHa),
                status: CheckoutStatus.ACTIVE,
              },
            ],
          },
        ]),
      },
      paymentCheckout: { updateMany },
    };
    const registry = {
      porConfigId: jest.fn().mockResolvedValue({
        gateway: {
          listCharges: jest
            .fn()
            .mockRejectedValue(
              new GatewayResourceNotFoundError('PayPal', 'ref-1'),
            ),
        },
        context: {},
      }),
    };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    return {
      service: new CronService(banco as any, registry as any),
      updateMany,
    };
  };

  it('passado o prazo, o checkout expira e sai das próximas rodadas', async () => {
    const { service, updateMany } = montar(25 * HORA);

    await service.reconciliar();

    expect(updateMany).toHaveBeenCalledWith({
      where: { referenceId: 'ref-1' },
      data: { status: CheckoutStatus.EXPIRED },
    });
  });

  it('dentro do prazo, o checkout continua ativo', async () => {
    const { service, updateMany } = montar(2 * HORA);

    await service.reconciliar();

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('checkout expirado não é consultado', async () => {
    const { service } = montar(25 * HORA);
    const banco = (service as any).prisma;
    banco.payment.findMany.mockResolvedValue([
      {
        eventId: null,
        checkouts: [
          {
            referenceId: 'ref-1',
            status: CheckoutStatus.EXPIRED,
            createdAt: new Date(),
          },
        ],
      },
    ]);

    const resumo = await service.reconciliar();

    expect(resumo.conferidas).toBe(0);
  });
});

import { ForbiddenException } from '@nestjs/common';

// o PDF não entra aqui; o puppeteer-core é ESM e o Jest não o carrega
jest.mock('puppeteer-core', () => ({}));
jest.mock('../pdf/navegador', () => ({}));

import { Role } from 'src/auth/roles';
import { QuadranteService } from './quadrante.service';

/**
 * Quem vê o quadrante (telefone, e-mail e foto da equipe). O inscrito precisa
 * de inscrição confirmada — não basta ter se inscrito no primeiro dia.
 */
const inscrito = { role: Role.USER, churchRoles: [] };

function montar({
  aprovacao = 'NOT_REQUIRED',
  emAberto = 0,
  crachaEntregue = false,
}: {
  aprovacao?: string;
  emAberto?: number;
  crachaEntregue?: boolean;
}) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(inscrito) },
    event: {
      findUnique: jest.fn().mockResolvedValue({
        churchId: 'A',
        // quadrante ligado, e o evento já começou
        data: { showQuadrante: true },
        startDate: new Date('2020-01-01T03:00:00Z'),
      }),
    },
    eventOnUsers: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ minorApprovalStatus: aprovacao }),
    },
    checkin: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          crachaEntregue ? { badgeDeliveredAt: new Date() } : null,
        ),
    },
    payment: { count: jest.fn().mockResolvedValue(emAberto) },
  };
  return new QuadranteService(prisma as any, {} as any);
}

describe('Quadrante — quem vê', () => {
  it('inscrição paga (ou gratuita): vê', async () => {
    await expect(montar({}).assertPodeVer('ev', 'u')).resolves.toBeUndefined();
  });

  it('inscrição com pagamento em aberto: não vê', async () => {
    await expect(
      montar({ emAberto: 1 }).assertPodeVer('ev', 'u'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('pagamento em aberto, mas crachá entregue no check-in: vê', async () => {
    await expect(
      montar({ emAberto: 1, crachaEntregue: true }).assertPodeVer('ev', 'u'),
    ).resolves.toBeUndefined();
  });

  it.each(['PENDING', 'REJECTED'])(
    'menor com termo %s: não vê',
    async (aprovacao) => {
      await expect(
        montar({ aprovacao }).assertPodeVer('ev', 'u'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('menor com termo aprovado: vê', async () => {
    await expect(
      montar({ aprovacao: 'APPROVED' }).assertPodeVer('ev', 'u'),
    ).resolves.toBeUndefined();
  });
});

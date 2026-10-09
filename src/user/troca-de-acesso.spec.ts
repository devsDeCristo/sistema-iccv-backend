import { ForbiddenException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { mascararEmail, mudaAcesso } from './acesso';
import { UserService } from './user.service';

/**
 * Tomada de conta entre igrejas: o admin da igreja A trocava o e-mail de quem
 * é admin da igreja B (bastava a pessoa estar inscrita num evento da A) e
 * pedia "esqueci a senha" — o código ia para o endereço novo.
 */
const alvo = {
  id: 'alvo',
  role: Role.ADMIN,
  email: 'dono@igrejab.com',
  cpf: '11111111111',
  fullName: 'Dono da B',
  sensitiveConsentAt: null,
};

function montar(requester: object, vinculosDoAlvo: string[]) {
  const tx = {
    user: {
      update: jest.fn(),
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: Role.ADMIN, churchRoles: [] }),
    },
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'alvo' ? alvo : { ...requester, fullName: 'Quem pediu' },
      ),
      // o alvo está no escopo de quem pede (inscrito num evento da igreja dele)
      findFirst: jest.fn().mockResolvedValue({ id: 'alvo' }),
    },
    userChurchRole: {
      findMany: jest
        .fn()
        .mockResolvedValue(vinculosDoAlvo.map((churchId) => ({ churchId }))),
    },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const mail = { loadTemplate: jest.fn(() => '<html/>'), sendMail: jest.fn() };
  const service = new UserService(prisma as any, {} as any, mail as any);
  return { service, mail, tx };
}

const adminDeA = {
  role: Role.ADMIN,
  churchRoles: [{ churchId: 'A', role: Role.ADMIN }],
};

describe('UserService — troca de e-mail/CPF entre igrejas', () => {
  it('admin da A não troca o e-mail de quem é admin da B', async () => {
    const { service, tx } = montar(adminDeA, ['B']);

    await expect(
      service.update('alvo', { email: 'atacante@x.com' } as any, 'adminA'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('nem o CPF', async () => {
    const { service } = montar(adminDeA, ['B']);

    await expect(
      service.update('alvo', { cpf: '99999999999' } as any, 'adminA'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('quem administra todas as igrejas da pessoa troca, e o e-mail antigo é avisado', async () => {
    const adminDeAeB = {
      role: Role.ADMIN,
      churchRoles: [
        { churchId: 'A', role: Role.ADMIN },
        { churchId: 'B', role: Role.ADMIN },
      ],
    };
    const { service, mail, tx } = montar(adminDeAeB, ['B']);

    await service.update('alvo', { email: 'novo@igrejab.com' } as any, 'admin');

    expect(tx.user.update).toHaveBeenCalled();
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'dono@igrejab.com' }),
    );
    expect(mail.loadTemplate).toHaveBeenCalledWith(
      'email-changed',
      expect.objectContaining({ novoEmail: 'no***@igrejab.com' }),
    );
  });

  it('super admin troca', async () => {
    const { service, tx } = montar(
      { role: Role.SUPER_ADMIN, churchRoles: [] },
      ['B'],
    );

    await service.update('alvo', { email: 'novo@igrejab.com' } as any, 'sa');
    expect(tx.user.update).toHaveBeenCalled();
  });

  it('editar outro campo de quem é de outra igreja continua permitido', async () => {
    const { service, tx, mail } = montar(adminDeA, ['B']);

    await service.update(
      'alvo',
      { fullName: 'Nome corrigido' } as any,
      'adminA',
    );
    expect(tx.user.update).toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});

describe('acesso', () => {
  it('mudaAcesso só conta e-mail/CPF diferentes do atual', () => {
    const atual = { email: 'a@x.com', cpf: '1' };
    expect(mudaAcesso({ email: 'a@x.com', cpf: '1' }, atual)).toBe(false);
    expect(mudaAcesso({}, atual)).toBe(false);
    expect(mudaAcesso({ email: 'b@x.com' }, atual)).toBe(true);
    expect(mudaAcesso({ cpf: '2' }, atual)).toBe(true);
  });

  it('mascararEmail', () => {
    expect(mascararEmail('fulano@gmail.com')).toBe('fu***@gmail.com');
    expect(mascararEmail('sem-arroba')).toBe('***');
  });
});

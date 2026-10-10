import { BadRequestException, ConflictException } from '@nestjs/common';
import { UserService } from './user.service';

/**
 * Sem índice único no banco (há repetidos antigos), quem barra e-mail repetido
 * novo é o `UserService`.
 */
function montar(emailsDeOutros: string[]) {
  const alvo = { id: 'u1', email: 'meu@gmail.com', role: 5 };
  const prisma = {
    user: {
      findUnique: jest.fn(async () => alvo),
      findFirst: jest.fn(async ({ where }: any) =>
        emailsDeOutros.includes(where.email) && where.id?.not === 'u1'
          ? { id: 'outro' }
          : null,
      ),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  return {
    servico: new UserService(prisma as any, {} as any, {} as any),
    prisma,
  };
}

describe('UserService — e-mail repetido', () => {
  it('cadastro com e-mail de outro: 409', async () => {
    const { servico, prisma } = montar(['usado@gmail.com']);
    prisma.user.findFirst.mockImplementation(async ({ where }: any) =>
      where.email === 'usado@gmail.com' ? { id: 'outro' } : null,
    );

    await expect(
      servico.create({ cpf: '1', email: 'usado@gmail.com' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('cadastro sem e-mail: 400', async () => {
    const { servico, prisma } = montar([]);

    await expect(
      servico.create({ cpf: '1', email: '' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('trocar para e-mail de outro: 409, nada gravado', async () => {
    const { servico, prisma } = montar(['usado@gmail.com']);

    await expect(
      servico.update('u1', { email: 'usado@gmail.com' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('quem já divide o e-mail (repetido antigo) salva o resto', async () => {
    // o próprio e-mail é de outro cadastro também, mas não está sendo trocado
    const { servico, prisma } = montar(['meu@gmail.com']);

    await servico.update('u1', {
      email: 'meu@gmail.com',
      fullName: 'Nome Novo',
    } as any);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

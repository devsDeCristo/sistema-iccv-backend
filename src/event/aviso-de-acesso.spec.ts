import { avisarAcessoAoEvento } from './aviso-de-acesso';
import { EventService } from './event.service';

/**
 * O e-mail de quem ganha um papel no evento. O `MailService` é dublê: nenhum
 * e-mail sai daqui.
 */
const PESSOAS = [
  { id: 'a', email: 'a@teste.invalid', fullName: 'Ana <b>' },
  { id: 'b', email: 'b@teste.invalid', fullName: 'Bia' },
];

const prisma = {
  event: {
    findUnique: async () => ({ name: 'Retiro', church: { name: 'ICCV' } }),
  },
  user: {
    findMany: async ({ where }: any) =>
      PESSOAS.filter((p) => where.id.in.includes(p.id)),
  },
} as any;

const dubleDoEmail = (falhaPara?: string) => {
  const variaveis: Record<string, string>[] = [];
  const enviados: string[] = [];
  return {
    variaveis,
    enviados,
    mail: {
      loadTemplate: (_: string, v: Record<string, string>) => {
        variaveis.push(v);
        return 'html';
      },
      sendMail: async ({ to }: { to: string }) => {
        if (to === falhaPara) throw new Error('caiu');
        enviados.push(to);
      },
    } as any,
  };
};

describe('Aviso de acesso ao evento', () => {
  it('avisa cada um, com o papel, e escapa o nome', async () => {
    const { mail, variaveis, enviados } = dubleDoEmail();
    await avisarAcessoAoEvento(prisma, mail, 'ev', [
      { userId: 'a', papel: 'ADMIN', mudou: false },
      { userId: 'b', papel: 'COMPLETO', mudou: true },
    ]);
    expect(enviados).toEqual(['a@teste.invalid', 'b@teste.invalid']);
    expect(variaveis[0]).toMatchObject({
      userName: 'Ana &lt;b&gt;',
      papel: 'admin',
      mensagem: 'Você agora é',
    });
    expect(variaveis[1]).toMatchObject({
      papel: 'tesoureiro(a) completo(a)',
      titulo: 'Seu acesso ao evento mudou',
    });
  });

  it('um envio que falha não impede os outros', async () => {
    const { mail, enviados } = dubleDoEmail('a@teste.invalid');
    await avisarAcessoAoEvento(prisma, mail, 'ev', [
      { userId: 'a', papel: 'ADMIN', mudou: false },
      { userId: 'b', papel: 'BASICO', mudou: false },
    ]);
    expect(enviados).toEqual(['b@teste.invalid']);
  });
});

describe('Equipe do evento — quem avisar', () => {
  const gravar = (antes: { admins: string[]; tesoureiros: any[] }) => {
    const tx = {
      eventAdmin: {
        findMany: async () => antes.admins.map((userId) => ({ userId })),
        deleteMany: async () => undefined,
        upsert: async () => undefined,
      },
      eventTreasurer: {
        findMany: async () => antes.tesoureiros,
        deleteMany: async () => undefined,
        upsert: async () => undefined,
      },
    };
    const servico = new EventService({} as any, {} as any, {} as any) as any;
    return (equipe: object) => servico.gravarEquipe(tx, 'ev', equipe, 'eu');
  };

  it('só quem entrou agora e o tesoureiro que trocou de tipo', async () => {
    const avisos = await gravar({
      admins: ['ja-admin'],
      tesoureiros: [
        { userId: 'mesmo', kind: 'BASICO' },
        { userId: 'trocou', kind: 'BASICO' },
      ],
    })({
      adminIds: ['ja-admin', 'novo-admin'],
      tesoureiros: [
        { userId: 'mesmo', kind: 'BASICO' },
        { userId: 'trocou', kind: 'COMPLETO' },
        { userId: 'novo-tes', kind: 'BASICO' },
      ],
    });
    expect(avisos).toEqual([
      { userId: 'novo-admin', papel: 'ADMIN', mudou: false },
      { userId: 'trocou', papel: 'COMPLETO', mudou: true },
      { userId: 'novo-tes', papel: 'BASICO', mudou: false },
    ]);
  });

  it('sem a equipe no pedido, ninguém é avisado', async () => {
    expect(await gravar({ admins: [], tesoureiros: [] })({})).toEqual([]);
  });
});

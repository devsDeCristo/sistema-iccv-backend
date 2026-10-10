import { desviarParaDev } from './mail.service';

describe('desviarParaDev (EMAIL_DEV_MODE)', () => {
  const envio = { to: 'fulano@gmail.com', subject: 'Inscrição confirmada' };

  it('sem a variável: segue para o destinatário de verdade', () => {
    expect(desviarParaDev(envio, undefined)).toBe(envio);
    expect(desviarParaDev(envio, '  ')).toBe(envio);
  });

  it('com a variável: vai só para o e-mail de dev, com o original no assunto', () => {
    expect(desviarParaDev(envio, ' dev@gmail.com ')).toEqual({
      to: 'dev@gmail.com',
      bcc: undefined,
      subject: '[DEV → fulano@gmail.com] Inscrição confirmada',
    });
  });

  it('envio em massa (cópia oculta): ninguém da lista recebe', () => {
    expect(
      desviarParaDev(
        { bcc: 'a@x.com,b@x.com', subject: 'Aviso' },
        'dev@gmail.com',
      ),
    ).toEqual({
      to: 'dev@gmail.com',
      bcc: undefined,
      subject: '[DEV → cco: a@x.com,b@x.com] Aviso',
    });
  });
});

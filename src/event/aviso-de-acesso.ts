import { Logger } from '@nestjs/common';
import { EventTreasurerKind } from '@prisma/client';
import { MailService } from 'src/mail/mail.service';
import { LOGO_DO_EMAIL } from 'src/mail/logo';
import { PrismaService } from 'src/prisma';
import { escapeHtml } from 'src/quadrante/quadrante-pdf';

/** O papel que alguém ganhou num evento: admin, ou tesoureiro(a) */
export type PapelNoEvento = 'ADMIN' | EventTreasurerKind;

/** Quem avisar: ganhou o papel agora, ou o tipo de tesoureiro mudou */
export interface AvisoDeAcesso {
  userId: string;
  papel: PapelNoEvento;
  mudou: boolean;
}

/** Como o e-mail chama cada papel, e o que ele dá (texto fixo, vai como HTML) */
const DO_PAPEL: Record<PapelNoEvento, { nome: string; oQuePode: string }> = {
  ADMIN: {
    nome: 'admin',
    oQuePode:
      'Você administra este evento pelo painel: inscritos, lista de espera, equipes, quartos, transporte, crachás, check-in, quadrante e pagamentos. Também consulta os membros da igreja e edita o cadastro deles.',
  },
  BASICO: {
    nome: 'tesoureiro(a)',
    oQuePode:
      'Você cuida dos pagamentos deste evento na aba Tesouraria do painel: confere comprovantes, dá baixa e estorna. Também consulta os membros da igreja.',
  },
  COMPLETO: {
    nome: 'tesoureiro(a) completo(a)',
    oQuePode:
      'Além da aba Tesouraria do evento, você vê Tesouraria › Eventos no painel, com a conciliação e os lançamentos dos seus eventos. Também consulta os membros da igreja.',
  },
};

const logger = new Logger('AvisoDeAcesso');

/**
 * Avisa por e-mail quem ganhou um papel no evento (ou teve o tipo de
 * tesoureiro trocado). Quem chama não espera: dar o acesso não pode falhar,
 * nem demorar, por causa do e-mail — a falha fica no log, uma por pessoa.
 */
export async function avisarAcessoAoEvento(
  prisma: PrismaService,
  mail: MailService,
  eventId: string,
  avisos: AvisoDeAcesso[],
) {
  if (!avisos.length) return;

  const [evento, pessoas] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, church: { select: { name: true } } },
    }),
    prisma.user.findMany({
      where: { id: { in: avisos.map((a) => a.userId) } },
      select: { id: true, email: true, fullName: true },
    }),
  ]);
  if (!evento) return;

  const painel = `${(process.env.URL_FRONTEND ?? '').replace(
    /\/$/,
    '',
  )}/admin/eventos`;
  const porId = new Map(pessoas.map((p) => [p.id, p]));

  for (const aviso of avisos) {
    const pessoa = porId.get(aviso.userId);
    if (!pessoa?.email) continue;
    const papel = DO_PAPEL[aviso.papel];
    try {
      const html = mail.loadTemplate('acesso-ao-evento', {
        titulo: aviso.mudou
          ? 'Seu acesso ao evento mudou'
          : 'Você agora faz parte da equipe do evento',
        userName: escapeHtml(pessoa.fullName),
        mensagem: aviso.mudou
          ? 'Seu acesso mudou: agora você é'
          : 'Você agora é',
        papel: papel.nome,
        eventName: escapeHtml(evento.name),
        churchName: escapeHtml(evento.church?.name ?? 'igreja'),
        oQuePode: papel.oQuePode,
        link: painel,
      });
      await mail.sendMail({
        to: pessoa.email,
        subject: `Você é ${papel.nome} do evento ${evento.name}`,
        html,
        attachments: LOGO_DO_EMAIL,
      });
    } catch (erro) {
      logger.error(
        `Aviso de acesso ao evento ${eventId} não saiu para ${aviso.userId}: ${
          (erro as Error).message
        }`,
      );
    }
  }
}

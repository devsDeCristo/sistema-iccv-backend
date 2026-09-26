import { BadRequestException } from '@nestjs/common';

/**
 * Quando cada grupo recebe inscrição: o liga/desliga e a janela de datas.
 *
 * Não há rotina que abra ou feche grupo na hora marcada. A data fica gravada e
 * a conta é feita a cada inscrição, contra o relógio do servidor — abre no
 * segundo certo, e servidor fora do ar na hora não deixa grupo preso fechado.
 */
export type JanelaDoGrupo = {
  name: string;
  active: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
};

const quando = (data: Date) =>
  data
    .toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    })
    .replace(', ', ' às ');

/** Por que o grupo não recebe inscrição agora; `null` quando recebe. */
export function grupoFechado(
  grupo: JanelaDoGrupo,
  agora = new Date(),
): string | null {
  if (!grupo.active) {
    return `O grupo "${grupo.name}" não está recebendo inscrições`;
  }
  if (grupo.opensAt && agora < grupo.opensAt) {
    return `As inscrições do grupo "${grupo.name}" abrem em ${quando(
      grupo.opensAt,
    )}`;
  }
  if (grupo.closesAt && agora >= grupo.closesAt) {
    return `As inscrições do grupo "${grupo.name}" encerraram em ${quando(
      grupo.closesAt,
    )}`;
  }
  return null;
}

/**
 * A janela como veio do formulário, pronta para gravar. Campo ausente fica de
 * fora — "não mexi nisso" —, senão um cliente que não conhece a opção
 * religaria grupo desligado a cada edição do evento. Vazio apaga a data.
 */
export function janelaRecebida(grupo: {
  name: string;
  active?: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
}) {
  const data = (valor?: string | null) =>
    valor === undefined ? undefined : valor ? new Date(valor) : null;

  const janela = {
    active: grupo.active,
    opensAt: data(grupo.opensAt),
    closesAt: data(grupo.closesAt),
  };

  if (janela.opensAt && janela.closesAt && janela.closesAt <= janela.opensAt) {
    throw new BadRequestException(
      `No grupo "${grupo.name}", o encerramento das inscrições precisa vir depois da abertura`,
    );
  }

  return janela;
}

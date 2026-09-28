# Inscrição em grupos

Cada evento tem grupos (`GroupRoles`) e cada grupo tem regras de valor
(`RolesRegistration`). Este módulo descreve **quando um grupo aceita inscrição**:
o liga/desliga e a janela de datas. A parte de tela está no repositório
`ic-front`, em `docs/inscricao-em-grupos.md`.

## Campos (`GroupRoles`)

| Campo | Tipo | Significado | Nulo |
| --- | --- | --- | --- |
| `active` | `Boolean @default(true)` | liga ou desliga o grupo | — |
| `opensAt` | `DateTime?` | a partir de quando aceita inscrição | aceita desde já |
| `closesAt` | `DateTime?` | até quando aceita inscrição | vale o **fim do evento** (`Event.endDate`) |

Migration: `prisma/migrations/20260926090000_group_registration_window`. Os
grupos que já existiam ficaram ativos e sem datas.

## Regra (`grupoFechado`)

`grupoFechado(grupo, agora, fimDoEvento)` devolve o motivo de o grupo **não**
aceitar inscrição agora, ou `null` quando aceita. As condições, na ordem:

1. `active === false` → "O grupo "X" não está recebendo inscrições"
2. `opensAt` no futuro → "As inscrições do grupo "X" abrem em dd/mm às hh:mm"
3. passou o encerramento → "As inscrições do grupo "X" encerraram em dd/mm às hh:mm"

- **Encerramento:** é `closesAt ?? fimDoEvento`. Um grupo sem data de encerramento aceita inscrição até o fim do evento. Quando o grupo tem `closesAt`, vale a data do grupo, antes ou depois do fim do evento.
- **Horário:** as datas das mensagens saem no horário de Brasília (`America/Sao_Paulo`). A conta usa o relógio do servidor, e não existe rotina agendada: o grupo abre e fecha no instante certo, mesmo se o servidor ficar fora do ar na hora.

Arquivo: `src/event/event-groups.ts`.

## Onde a regra é aplicada

- **Uma só entrada:** `_registerUserInEventTx` (`src/event/event.service.ts`), por onde passa toda inscrição, inclusive a entrada na lista de espera. A checagem vem **antes** da contagem de vagas, então um grupo fechado não aceita nem lista de espera.
- **Chamada:** `grupoFechado(role.group, new Date(), event.endDate)`.
- **Resposta:** inscrição recusada recebe `400` com a mensagem.

### Quem passa pela trava

A trava vale só para quem **se inscreve sozinho** (`requesterId === userId`,
flag `respeitarJanela`). Passam direto:

- o admin inscrevendo outra pessoa pelo painel, que é como se coloca alguém num grupo interno ou numa vaga depois do prazo;
- as chamadas internas sem `requesterId`: troca de grupo pelo admin e lista de espera andando.

## Gravação (`janelaRecebida`)

- **Campo ausente no corpo não é gravado:** "não mexi nisso". Assim, um cliente que não conhece os campos não religa um grupo desligado a cada edição do evento.
- **String vazia ou `null` apaga a data.**
- **Ordem das datas:** com as duas datas no corpo, `closesAt` precisa ser depois de `opensAt`, senão a resposta é `400`.
- **DTO (`GroupRoleDto`):** `active` (boolean), `opensAt` e `closesAt` (string ISO, opcionais).

## Testes

`src/event/event-groups.spec.ts` cobre:

- grupo ativo sem datas;
- grupo desligado;
- abertura no segundo marcado, no horário de Brasília;
- encerramento no horário marcado;
- encerramento no fim do evento quando o grupo não tem data;
- data do grupo mandando, mesmo depois do fim do evento;
- gravação: campo ausente não mexe, vazio apaga, e encerramento antes da abertura é recusado.

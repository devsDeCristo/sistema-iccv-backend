# Rotinas agendadas (cron)

O módulo `src/cron` mantém as rotinas automáticas do sistema, agendadas com
`@nestjs/schedule`. Cada rotina roda dentro de um contexto próprio
(`runAsJob`), para que suas escritas apareçam no log de auditoria com origem
`CRON` e um nome, em vez de ficarem soltas ou parecerem ação humana — ver
`docs/logs-e-auditoria.md`.

Arquivos: `src/cron/cron.service.ts`, `src/cron/cron.module.ts`.

## `runAsJob`

Definido em `src/context/request.context.ts`. Cria um contexto de requisição
com `requestId` novo, `operation: "CRON <nome>"` e `source: 'CRON'`, e roda a
rotina dentro dele. É o que faz o middleware de auditoria do `PrismaService`
gravar as escritas da rotina como uma ação do sistema, identificável e
agrupável, em vez de linhas soltas sem origem.

## Rotinas existentes

| Rotina | Agenda | O que faz |
| --- | --- | --- |
| `reconcilePayments` | `EVERY_3_HOURS` | reconcilia cobranças pendentes com os gateways de pagamento |
| `purgeExpiredUserTokens` | `EVERY_DAY_AT_3AM` | apaga tokens de redefinição de senha vencidos |

### Reconciliação de pagamentos

Busca pagamentos com status `WAITING` ou `IN_ANALYSIS` que já têm checkout, e
confere cada um no gateway que gerou a cobrança. O funcionamento completo —
como resolve a credencial, como confere o valor pago, o que faz quando o
status muda — está documentado em `docs/pagamentos.md`; aqui vale registrar
só o que a rotina, como cron, decide sozinha:

- **Dois gatilhos, mesmo método:** o relógio (`EVERY_3_HOURS`) chama
  `reconciliar()` sem filtro, rodando a fila inteira; o painel chama
  `reconciliar({ eventId })` via `POST /events/:idEvent/payments/reconcile`
  (rota `Role.DEV`, disparo sob demanda para quem não quer esperar o relógio).
  A lógica é a mesma função nos dois casos — o cron só decide o `filtro`.
- **O que a rotina ignora:** cobranças de eventos cuja igreja está com
  `Church.modulePayment = false`. Desligar o módulo de pagamento de uma igreja
  precisa parar tudo, inclusive a parte que roda sozinha sem ninguém olhando a
  tela — sem esse filtro a rotina continuaria consultando o gateway e dando
  baixa numa igreja que, para o resto do sistema, não cobra mais.
- **Erro em uma cobrança não trava a rodada:** falha ao consultar um gateway
  (rede, credencial ausente, recurso não encontrado no gateway) é registrada e
  a rotina segue para a próxima cobrança pendente.
- **Retorno:** `{ conferidas, atualizadas }` — quantas cobranças entraram na
  rodada e quantas mudaram de status. É o que a rota manual devolve ao painel.

### Limpeza de tokens vencidos

`purgeExpiredUserTokens` apaga em lote (`deleteMany`) as linhas de
`UserToken` com `expiresAt` no passado. Cobre quem pediu redefinição de senha
e nunca voltou a usar o código — o token expira sozinho, mas a linha só some
do banco por esta rotina. Roda uma vez por dia, às 3h.

## Testes

Não há `*.spec.ts` em `src/cron`.

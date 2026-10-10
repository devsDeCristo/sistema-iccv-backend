# Logs e auditoria

O sistema audita as escritas do banco automaticamente, através de um
middleware do Prisma, e mantém três trilhas separadas: atividades gerais
(`Log`), tentativas de login (`LoginAttempt`) e o histórico do dinheiro
(`PaymentLog`, detalhado em `docs/pagamentos.md`).

## Contexto da requisição (`src/context`, `src/middleware`)

- **`RequestContextInterceptor`** (`src/middleware/request-context.middleware.ts`)
  roda em toda requisição HTTP e grava, num `AsyncLocalStorage`
  (`src/context/request.context.ts`):
  - `userId`: de `req.user`, já autenticado pelo guard;
  - `requestId`: um UUID novo por requisição — é o que amarra na tela de
    atividades as várias escritas de uma mesma ação (uma inscrição grava em
    inscrição, pagamento e vínculo de grupo, por exemplo);
  - `operation`: o molde da rota sem os ids, tipo `POST
    /events/:idEvent/users/:idUser` — vem dos metadados do Nest
    (`PATH_METADATA`), não de `req.route`;
  - `source`: `WEBHOOK` para rota `/webhooks/*`, `PANEL` quando há usuário
    autenticado, `SYSTEM` nas demais rotas públicas (ex.: inscrição pública que
    gera cobrança).
- **`runAsJob(nome, executar)`** (`src/context/request.context.ts`) cria o
  mesmo contexto para rotinas do `src/cron`: `requestId` novo,
  `operation = "CRON <nome>"`, `source: 'CRON'`. Sem isso, cada escrita de uma
  rotina apareceria solta no log, sem nome nem origem — e a reconciliação de
  pagamento, que muda status sem ninguém pedir, ficaria indistinguível de uma
  ação humana.

## Auditoria automática (`PrismaService`)

Arquivo: `src/prisma/prisma.service.ts`. Um middleware do Prisma (`$use`)
intercepta `create`, `update`, `delete`, `createMany`, `updateMany`,
`deleteMany` e `upsert` de qualquer model e grava uma linha em `logs` com
`model`, `action`, `entityId`, `before`, `after`, `userId`, `requestId`,
`operation` e `targetUserIds` (quem a ação atingiu).

### O que fica de fora

| Model | Motivo |
| --- | --- |
| `Log` | não se audita a própria auditoria |
| `PaymentLog` | é log também — auditar geraria linha genérica em dobro para a mesma escrita financeira |
| `WhatsappAuth` | são as chaves do Signal, reescritas a cada mensagem trocada; encheria a tabela e copiaria material criptográfico |
| `LoginAttempt` | é um registro por tentativa de entrada; auditar geraria uma linha de log por login, e o log de auditoria existe para contar o que as pessoas mudam, não quantas vezes entram |

### Campos ocultados dentro do que é auditado (`REDACTED_FIELDS`)

| Model | Campos escondidos |
| --- | --- |
| `User` | `password` |
| `UserToken` | `codeHash`, `ticketHash` |
| `PaymentProviderConfig` | `credentials`, `webhookSecretHash` |
| `EventProduct` | `images` (só volume: fotos em base64) |

Campo escondido não desaparece sem deixar rastro: quando muda, a linha grava
o marcador `(alterada)` no lugar do valor — assim uma troca de senha continua
aparecendo como evento, em vez de ser descartada como "nada mudou" por
comparar dois valores omitidos e iguais.

### Regras de gravação

- **Sem alteração real, sem linha:** um `update` que não muda nada (salvar um
  formulário sem editar) não gera log. A comparação ignora `createdAt` /
  `updatedAt`.
- **`update`/`upsert` usam o próprio resultado como "depois"**, não uma
  releitura — dentro de transação interativa a releitura roda por fora dela e
  traria o estado antigo, fazendo a alteração sumir da auditoria.
- **Lote (`updateMany`/`createMany`/`deleteMany`) vira uma linha de log por
  registro afetado**, pareado por id — assim uma chamada da lista de espera
  que atualiza doze pagamentos gera doze linhas, cada uma com o que mudou
  naquele registro.
- **`updateMany` dentro de transação** calcula o "depois" aplicando os dados
  do próprio `update` sobre o "antes" (`applyUpdateData`), em vez de reler —
  mesmo motivo do `update` simples. Só desiste (log com "depois" nulo) quando o
  pedido usa operador de banco (`{ increment: 1 }` e afins), porque aí o
  resultado depende do estado real do banco.

## Trilha do dinheiro (`PaymentLog`)

Quando a escrita é em `Payment`, `PaymentCheckout` ou `Discounts`
(`FINANCE_MODELS`), o mesmo middleware grava **também** uma linha em
`PaymentLog`, em paralelo à linha genérica de `Log` (uma não substitui a
outra). Ela guarda `amountBefore/After`, `statusBefore/After`, `source`
(`PANEL`/`WEBHOOK`/`CRON`/`SYSTEM`), `actorId`, `operation`, `requestId` e o
restante das mudanças em `changes` (json de diffs, campo a campo). Campo
`payload` (retorno do gateway) é grande demais para copiar duas vezes e vira
o marcador `(atualizado)`. Consulta: `GET
/events/:idEvent/payments/logs` (rota `ADMIN_AREA_ROLES`, protegida por
`EventTenantGuard`, então cada igreja só vê o próprio caixa) — implementada em
`src/payment/payment.service.ts`. O detalhe da reconciliação com os gateways
(PagBank/Mercado Pago) está em `docs/pagamentos.md`.

## Log de atividades (`src/logs`)

- **Rota:** `GET /logs` (lista agrupada), `GET /logs/:id` (detalhe de uma
  ação), `GET /logs/operations` (catálogo de operações para o filtro),
  `GET /logs/login-attempts`.
  - **Atividades** (`/logs`, `/logs/:id`, `/logs/operations`): dev e super
    admin (`SUPER_ADMIN_ROLES`). O antes e o depois expõem dado pessoal de
    qualquer pessoa, de todas as igrejas, então só entra quem já atravessa
    todas elas. Admin de igreja não entra. Até 10/10/2026 era só o dev.
  - **Tentativas de login** (`/logs/login-attempts`): só o dev (`@Roles` na
    rota, que vence o da classe), porque documento, IP e aparelho de cada
    tentativa são investigação de segurança.
- **Agrupamento:** as linhas de uma mesma `requestId` (ou o próprio `id`, no
  histórico anterior à coluna) viram uma "ação" só na listagem, paginada por
  ação e não por linha — inscrever alguém não pode ser cortado ao meio entre
  duas páginas.
- **Linha principal do grupo:** entre as tabelas tocadas pela mesma ação,
  ganha a que representa algo no mundo (`MAIN_MODELS`: `User`, `Payment`,
  `Event`, `Team`, `Bedrooms`, `News`, `GroupRoles`, `RolesRegistration`,
  `Discounts`, `Checkin`, `Waitlist`, `Church`) sobre uma tabela de vínculo;
  empatado nisso, ganha quem teve mais campos alterados.
- **Rótulos legíveis:** `src/logs/log-labels.ts` traduz nome de tabela, verbo
  do Prisma e o molde de rota (`operation`) para português; `src/logs/log-diff.ts`
  formata os valores (moeda, data, enum, papel) e trata campos de vínculo
  (`*Id`) mostrando só "definido"/"—", nunca o uuid.
- **Dispositivo do login:** `src/logs/dispositivo.ts` deriva tipo de aparelho,
  sistema operacional, navegador e motor a partir do `User-Agent`, sem afirmar
  o que o texto não garante (ex.: iPad em modo desktop se apresenta como Mac e
  fica indistinguível).
- **Filtros (`ListLogsDto`):** período (`from`/`to`, padrão últimas 24h),
  `userId` ("envolvido": traz o que a pessoa fez e o que fizeram com ela),
  `model`, `action`, `operation`, paginação (`page`, `limit`, teto 100).

## Tentativas de login

Gravadas em `LoginAttempt` (fora do middleware de auditoria — ver acima),
com `document`, `userId` (nulo quando o documento não bate com ninguém),
`success`, `reason` (só nas falhas, ex.: senha errada vs. documento
inexistente), `method` (`PASSWORD` ou `GOOGLE`; no Google, `document` é o
e-mail da conta Google), `ip` e `userAgent`. Senha nunca é gravada, nem em claro nem em
hash. Consulta: `GET /logs/login-attempts`, mesmo filtro de período e
paginação do log de atividades, com resumo de sucesso/falha.

## Quem consulta

| Trilha | Rota | Quem pode |
| --- | --- | --- |
| Atividades gerais | `GET /logs`, `/logs/:id`, `/logs/operations` | dev e super admin |
| Tentativas de login | `GET /logs/login-attempts` | `Role.DEV` |
| Dinheiro do evento | `GET /events/:idEvent/payments/logs` | `ADMIN_AREA_ROLES`, restrito à própria igreja |

Tela correspondente: `ic-front/docs/logs-e-logins.md` (atividades e login) e
`ic-front/docs/admin-pagamentos.md` (histórico financeiro do evento).

## Testes

`src/logs/dispositivo.spec.ts` cobre a leitura do `User-Agent` (iPhone, iPad
em modo desktop, Android disfarçado de "K", Windows, macOS, navegadores e
apps embutidos). Não há spec para o middleware de auditoria em si
(`prisma.service.ts`) nem para `logs.service.ts`.

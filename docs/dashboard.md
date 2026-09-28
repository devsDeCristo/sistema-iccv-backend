# Dashboard

Tela de abertura do painel administrativo: uma rota só, cujo conteúdo muda conforme o perfil de quem pergunta e, opcionalmente, qual igreja foi pedida. O eixo dos números é sempre o evento — o serviço evita somar inscritos, vagas ou dinheiro de todos os eventos de todos os anos, porque esse total não decide nada.

Arquivos: `src/dashboard/dashboard.controller.ts`, `src/dashboard/dashboard.service.ts`, `src/dashboard/dto/dashboard-query.dto.ts`.

## Rota

| Método | Caminho | Quem pode | Query |
| --- | --- | --- | --- |
| `GET` | `/dashboard` | `ADMIN_AREA_ROLES` (dev, super admin, admin, financeiro) | `churchId` opcional |

Guardas: `JwtAuthGuard`, `RolesGuard`. Sem `EventTenantGuard` — o recorte por igreja é feito dentro do serviço, porque a rota não pertence a um evento específico.

## `churchId`: abrir a home de outra igreja

- Usado pelo super admin para abrir a home de uma igreja específica a partir da lista de igrejas; o admin/financeiro comuns chegam na própria home sem passar o parâmetro.
- **Não é uma chave de acesso.** Quem pode abrir cada igreja é decidido pelo vínculo de quem pediu (`assertChurchAccess`): super admin atravessa todas; admin e financeiro só alcançam as igrejas em que têm vínculo. Pedir a igreja de outra pessoa dá `403` "Você não administra esta igreja" — checado **antes** de confirmar se a igreja existe, para a resposta não revelar quais ids existem.
- Igreja inexistente: `404` "Igreja não encontrada".

## Escopo: `system` vs `church`

O campo `scope` da resposta diz qual dos dois formatos veio:

- **`church`:** quando há recorte por igreja — seja porque `churchId` foi passado, seja porque quem pediu (admin/financeiro) só alcança as suas. Vem com `events`, `recentRegistrations`, `treasury` (se financeiro) e `news` (mural).
- **`system`:** quando quem pediu é super admin ou dev **sem** `churchId` (`tenantChurchIds` devolve `null`, ou seja, nenhum recorte). Vem com `byChurch` (leitura por igreja), e, dependendo do perfil, `panorama` (super admin) ou `insights` (dev). `events`, `recentRegistrations` e `news` saem `null` nesse modo.

## Conteúdo por perfil

| Bloco | Quem recebe | Descrição |
| --- | --- | --- |
| `churches` | quem tem recorte (`scope: church`) | igrejas da pessoa, cada uma com o perfil que ela tem lá (pode ser admin de uma e financeiro de outra) |
| `events` | quem tem recorte, exceto financeiro na leitura de "abertos" (financeiro recebe `eventosComSaldo`, ver abaixo) | eventos da igreja, todos do mesmo tamanho na tela |
| `pending` | todos com recorte, exceto lista de espera para financeiro | pendências acionáveis: comprovantes em análise e lista de espera com vaga livre |
| `recentRegistrations` | quem tem recorte, exceto financeiro | últimas 6 inscrições, com pessoa e evento |
| `treasury` | só financeiro | resumo de cobrança em aberto (ver "Métricas financeiras") |
| `news` | quem tem recorte e não é financeiro | mural: últimas 3 notícias publicadas + contagem de rascunhos |
| `byChurch` | super admin/dev sem `churchId` | uma linha por igreja: admins, total de eventos, inscrições históricas, eventos abertos, evento em destaque |
| `panorama` | super admin sem `churchId` | base de usuários do sistema (ver "Panorama do super admin") |
| `insights` | dev sem `churchId` | indicadores de funcionamento do sistema (ver "Indicadores do dev") |

### Quais eventos aparecem em `events`

- **Administração comum (admin, super admin, dev com recorte):** os eventos com `status` em `ACTIVE` ou `TEST` (`eventosAbertos`). Sem nenhum aberto, a lista não fica vazia — entra o último evento encerrado (`ultimoEncerrado`), para a tela não abrir em branco no dia seguinte ao evento. **A data de término não filtra este conjunto**: um evento marcado `ACTIVE` continua aparecendo mesmo depois de terminar, porque o dinheiro dele (comprovantes a conferir) não desaparece com o fim do evento.
- **Financeiro:** `eventosComSaldo` — os eventos ativos **mais qualquer evento com pagamento `WAITING` ou `IN_ANALYSIS`**, esteja ele desligado ou encerrado há meses. Ordenados pelo valor em aberto, do maior para o menor — é a fila de trabalho do financeiro.
- Cada evento detalhado (`detalhar`) traz: fase (`ongoing`/`upcoming`/`finished`, calculada pelo dia cheio, contando o dia inteiro nas duas pontas), pessoas inscritas, ocupação por grupo de inscrição (com capacidade em `GroupRoles.capacity`), lista de espera, caixa (`finance`), ritmo de inscrição (últimos 7 dias vs. os 7 anteriores) e check-in (`null` enquanto ninguém fez check-in ainda, para não mostrar "0 de N" como se fosse alarme).

### Pendências (`pending`)

Duas categorias, cada uma amarrada a um evento específico:

- **`receipts`:** evento com comprovante `IN_ANALYSIS` > 0 — mesmo em evento já encerrado, porque o dinheiro continua sendo tarefa.
- **`waitlist`:** evento com lista de espera **e** vaga livre (`seats.total - seats.taken > 0`), e que ainda não terminou (`phase !== 'finished'`). Fila em evento lotado não é pendência; chamar alguém para um evento já encerrado também não é. Financeiro nunca recebe pendência de lista de espera — quem chama da fila é quem administra a inscrição.

## Métricas financeiras (`treasury`, só financeiro)

- **`debtors`:** pessoas distintas, número de cobranças e valor total com pagamento `WAITING` nos eventos do recorte.
- **`refunded`:** contagem e valor de pagamentos `REFUNDED`.
- Limitação assumida no código: o sistema não registra despesa, só entrada (`Payment`). `refunded` é a única "saída" que existe — não há como montar um fluxo de caixa completo sem uma tabela de despesas.
- `finance.expected` (dentro de cada evento detalhado) soma `PAID` + `IN_ANALYSIS` + `WAITING`: dinheiro pago ou a caminho. Recusado, cancelado e estornado ficam de fora.

## Panorama do super admin (sem `churchId`)

Só aparece para `Role.SUPER_ADMIN` no escopo `system`. Não fala de operação de evento — responde "quantas igrejas existem e como vão" e "quem são as pessoas do sistema":

- `users.total`, `users.newThisMonth`, `users.byMonth` (12 meses, com meses vazios preenchidos com zero).
- `users.byRole`: contagem por perfil.
- `users.neverRegistered`: cadastrado que nunca entrou em evento nem em lista de espera.
- `users.withChurchLink`: pessoas com algum vínculo de igreja (conta pessoa, não vínculo — quem administra duas igrejas conta uma vez). Super admin e dev não têm vínculo de propósito, então ficam fora desse número.
- `churchActivity`: ações registradas (tabela `logs`) por igreja nos últimos 30 dias, atribuídas pela igreja de quem **agiu** (o autor), não pelo alvo da ação.

## Indicadores do dev (sem `churchId`)

Só aparece para `Role.DEV` no escopo `system`. Fala do funcionamento do sistema:

- `registrationsByMonth`: inscrições por mês, 12 meses.
- `activityByDay` / `loginsByDay`: atividade (`logs`) e tentativas de login (`login_attempts`, sucesso/falha) nos últimos 14 dias. Dias anteriores à criação da tabela de tentativas de login vêm zerados por falta de registro, não porque ninguém tentou entrar.
- `topChurches`: até 6 igrejas ordenadas por número de eventos, com inscrições acumuladas.
- `topActors`: até 5 pessoas com mais ações registradas nos últimos 30 dias. **Nota do próprio código:** o sistema não registra login/acesso — só escritas, via middleware do Prisma na tabela `logs`. Este bloco mostra quem mais *movimenta* o sistema, não quem mais entra nele; medir acesso de fato exigiria uma coluna nova.

## Fuso horário nas séries por dia/mês

As colunas de data são gravadas em UTC pelo Prisma (`timestamp without time zone`), mas as séries agrupam por dia/mês local (`America/Sao_Paulo` ou `TZ` do ambiente). O SQL faz a conversão explícita (`AT TIME ZONE 'UTC' AT TIME ZONE <fuso>`) antes de agrupar — sem isso, tudo que acontece depois das 21h em Brasília cairia no dia seguinte, e o intervalo entre 21h e meia-noite sumiria dos gráficos todo dia.

## Tela correspondente

Front (`ic-front/docs`): `admin-home.md`.

# Servidor HTTP

Configuração do servidor que vale para todas as rotas: CORS e log de
requisições. Fica em `src/main.ts` e em `src/common/interceptors/logging.interceptor.ts`.

## CORS

O front roda em outra origem, e todo pedido autenticado leva o cabeçalho
`Authorization`. Por isso o navegador manda antes um **preflight** (`OPTIONS`)
perguntando se pode fazer a chamada.

| Opção | Valor | Por quê |
| --- | --- | --- |
| `origin` | `true` | aceita a origem que chamou |
| `credentials` | `true` | cookies e credenciais liberados |
| `exposedHeaders` | `Content-Disposition` | o front lê o nome do arquivo baixado (PDF do quadrante, crachás) |
| `maxAge` | `7200` | o navegador guarda a resposta do preflight por 2h (teto do Chrome) |

- **Sem `maxAge`:** o Chrome guarda a resposta do preflight por 5 segundos. Quase toda troca de página, depois de uma pausa, pedia permissão de novo antes de cada chamada. O cache é por URL e método, então cada rota nova ainda faz um preflight na primeira vez.
- **Preflight não aparece no log:** ele é respondido pelo middleware de CORS antes de chegar às rotas e ao interceptor. Um preflight lento só aparece no navegador (aba Rede do DevTools, tipo `preflight`).

Arquivo: `src/main.ts`.

## Log de requisições

- **Linha do log:** usuário, método, caminho (a query só com o nome dos parâmetros), status e tempo. Todas as rotas aparecem, inclusive `/auth/validate` e `/auth/admin/validate`.
- **O que o tempo mede:** do interceptor até a resposta do handler. O Nest executa os **guards e middlewares antes** do interceptor, então não entram na conta:
  - a autenticação (`JwtAuthGuard`);
  - os guards que consultam o banco (`RolesGuard`, `EventTenantGuard`);
  - o preflight de CORS;
  - o tempo que o pedido esperou na fila, se o processo estava ocupado.
- **Na prática:** um log de poucos ms com o navegador marcando segundos quer dizer que a demora está antes do interceptor ou fora do Node (rede, proxy, preflight). Para separar, veja a aba "Timing" do pedido no DevTools: espera longa em "Waiting for server response" aponta para o servidor; em "Stalled" ou "Initial connection" aponta para a conexão ou o proxy.

Arquivo: `src/common/interceptors/logging.interceptor.ts`.

## Monitor do processo

A cada minuto o processo mede o atraso do event loop e a memória. Serve para
descobrir travamentos que o log de requisições não mostra: um pedido que
esperou na fila com o Node ocupado, ou um preflight lento.

- **Aviso (`WARN`, contexto `[Processo]`):** sai quando, no último minuto, o p99 do atraso passou de **200ms**, o pior caso passou de **1s** ou a memória do container chegou a **90% do limite**. O texto é "Processo travou no último minuto", seguido dos números.
- **Linha de rotina (`LOG`):** a cada 10 minutos, mesmo sem nada anormal. É a linha de base para comparar.
- **O que cada linha traz:**
  - atraso do event loop: p50, p99 e o pior caso do minuto;
  - `ocupado`: fração do tempo em que o loop trabalhou;
  - memória do Node: `rss` (só o processo do Node), heap usado e total, limite do heap e memória externa (buffers);
  - `container: usado/limite`: o container inteiro, incluindo o Chrome do Puppeteer, que é outro processo e não entra no `rss`. Vem do cgroup (`/sys/fs/cgroup`, v2 ou v1), descontando o cache de arquivo inativo, a mesma conta do `docker stats`. Não aparece fora de container nem em container sem limite de memória.
- **Piso de ~20ms:** o histograma amostra a cada 20ms, então p50 e p99 em torno de 20ms são o normal, não atraso.
- **Como ler um travamento:**
  - `pior` alto com `ocupado` alto: CPU na thread principal (processar mensagens do WhatsApp, juntar PDF, JSON grande).
  - heap usado perto do limite, subindo ao longo das horas: pressão de memória, com pausas do coletor de lixo. Isso some ao reiniciar.
  - `container` perto do limite com o `rss` baixo: quem ocupa é o Chrome. Perto do limite, o kernel toma memória à força e tudo no container fica lento, até o Node ser morto. A API roda com `memory: 512M` na stack, dividida com o Chrome.
  - Cruze o horário com o resto do log: WhatsApp reconectando, PDF sendo gerado, cron de conciliação.
- **Custo:** um histograma nativo do Node, um timer por minuto, que não segura o processo aberto (`unref`), e a leitura de três arquivos pequenos do cgroup por minuto.

Arquivos: `src/common/monitor-do-processo.ts` (e o `.spec.ts`), iniciado no começo do `bootstrap` em `src/main.ts`.

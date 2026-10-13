# Planos (módulos por igreja)

O plano de uma igreja diz quais módulos ela usa. Fora do plano, o módulo some do painel daquela igreja e a API dele recusa; **nada é apagado** — voltar o módulo ao plano devolve tudo.

**O plano recorta quem trabalha na igreja** (admin, tesouraria). **Dev e super admin veem todos os módulos de todas as igrejas**: o plano não vale para eles.

Código: `src/planos` (`PlanosController`, `PlanosService`, `ModuloGuard`, `modulos.ts`).

## Modelo

- `Plan { id, name (único), description?, price, modules ChurchModule[] }`, tabela `plans`. `price` é o **valor mensal** em reais, `Decimal(10,2)` (como o dinheiro do livro-caixa), padrão 0 = gratuito; a API devolve número.
- `Church.planId` (opcional, `onDelete: Restrict`): o plano da igreja.
- **Igreja sem plano não tem módulo nenhum**: só o painel básico (Início, Meus planos e Membros; Usuários é só de dev e super admin). Nenhuma igreja nasce com plano — nem as que já existiam: depois da migração, o super admin escolhe um plano para cada uma em Igrejas.
- Os limites que vierem (quantidade de eventos e etc.) entram no `Plan` como colunas próprias.

### Módulos (`ChurchModule`)

**Membros não é módulo:** toda igreja tem, com ou sem plano (e a tesouraria depende dele — os dizimistas são os membros). **As configurações seguem o módulo a que servem:** Pagamentos é de Eventos, Disparadores (WhatsApp) de Notícias, Integrações (Pluggy) de Tesouraria — WhatsApp e Integrações já foram módulos próprios e saíram (migration `20261012130000`).

| Módulo     | O que fecha                                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENTS`   | Painel de eventos: criar, editar, inscritos, equipes, quartos, transporte, crachás, check-in e os pagamentos do evento no painel; a configuração dos gateways (`/churches/:churchId/payment-providers`, a tela Pagamentos); e a cobrança online nas inscrições (ver abaixo) |
| `NEWS`     | Notícias e disparos; e o WhatsApp da igreja (`/churches/:churchId/whatsapp`, a tela Disparadores)                                                                                                                                                                           |
| `TREASURY` | Tesouraria (`/churches/:churchId/tesouraria`); e os bancos pela Pluggy (`/churches/:churchId/pluggy`, a tela Integrações)                                                                                                                                                   |

## Rotas (`/plans`)

Só **dev e super admin** (`SUPER_ADMIN_ROLES`), como a gestão de igrejas.

| Método   | Rota         | O que faz                                                                |
| -------- | ------------ | ------------------------------------------------------------------------ |
| `GET`    | `/plans`     | Lista, com `_count.churches`                                             |
| `POST`   | `/plans`     | `{ name, description?, price, modules[] }` (`price` ≥ 0, até 2 decimais) |
| `PUT`    | `/plans/:id` | Atualiza; os módulos novos valem na hora para as igrejas do plano        |
| `DELETE` | `/plans/:id` | Só plano que nenhuma igreja usa (409 com quantas usam)                   |

As listas vêm do mais barato ao mais caro (e por nome). Nome repetido (sem diferenciar maiúsculas) responde 409. O plano da igreja se escolhe em `POST/PUT /churches` (`planId`; `null` tira o plano; omitido na edição mantém) — ver `docs/igrejas.md`.

## "Meus planos" (`GET /churches/:churchId/plano`)

Para quem trabalha na igreja: `ADMIN_AREA_ROLES` + `ChurchTenantGuard` (admin e tesouraria **desta** igreja; dev e super admin). Só leitura: `{ atual, planos }` — o plano da igreja (ou `null`) e todos os planos, do mais barato ao mais caro, com nome, descrição, valor e módulos. **Sem** quantas igrejas usam cada plano: não é da conta de uma igreja. `PlanoDaIgrejaController`.

## Como o módulo é cobrado

- **`@Modulo(ChurchModule.X)` + `ModuloGuard`** nos controllers do módulo, no fim do `@UseGuards` (depois do login e do recorte por igreja). Não é global de propósito: rodaria antes do login, e um anônimo leria na recusa o nome da igreja.
- **Recusa:** 403 "O plano de <igreja> não inclui o módulo <módulo>". **Dev e super admin passam** (o perfil lido do banco pelo `RolesGuard`, que roda antes).
- **Só o painel:** rota sem `@Roles` é área do usuário (ver evento, inscrever-se, pagar a própria inscrição) e passa. O evento já publicado segue aberto ao público com Eventos fora do plano.
- **Cobrança online** não é acesso de ninguém: é se a igreja cobra. Sem Eventos no plano ela não cobra, quem quer que abra o checkout.
- **A igreja sai da rota:** `:churchId`; o evento (`:idEvent`, `:eventId`, ou `:id` nas rotas de Eventos); o pagamento (`:paymentId` → evento); a notícia (`:id` nas rotas de Notícias); ou o `churchId` do corpo. Sem nada disso (listas de várias igrejas, criação sem igreja escolhida), passa.
- **Criação:** criar evento e criar notícia (e trocar a notícia de igreja) conferem no service, depois de saber a igreja — quem administra uma igreja só nem manda o `churchId`. Dev e super admin passam aqui também.
- **Listas e ações de várias igrejas** (sem igreja na rota) filtram no service, para quem não é dev nem super admin:
  - `GET /events` do painel: só eventos de igreja com Eventos (vale também para o tesoureiro(a) de evento);
  - `GET /news/admin` e o calendário de disparos: só notícias de igreja com Notícias;
  - home (`GET /dashboard`, ver `docs/dashboard.md`): eventos, inscrições recentes e caixa só das igrejas com Eventos; mural só das com Notícias;
  - status em massa (`PUT /events/status`): evento de igreja sem Eventos volta em `falhas`.
- **Cron de notícias:** agendamento de notícia de igreja sem Notícias não dispara (o horário passa e segue para o próximo). Notícia do sistema (sem igreja) dispara.
- **Fora do recorte, de propósito:** os indicadores do dev (o plano não vale para ele) e o público (`GET /events` sem painel, o feed de notícias) — o publicado segue aberto ao público.

## Cobrança online (parte de Eventos)

**Quem tem Eventos no plano cobra pelo site** (se tiver gateway configurado): dar às igrejas o suporte a pagamentos é parte do que o módulo de eventos é. Já foi um módulo próprio (`ONLINE_PAYMENTS`), que saiu na migration `20261012150000`. Substituiu `Church.modulePayment` (a coluna saiu na migração; a rota `PATCH /churches/:churchId/payment-providers/module` também). Quem lia o campo agora usa `cobraOnline(igreja)` / `SELECT_MODULOS` / `SEM_COBRANCA_ONLINE` (`src/planos/modulos.ts`): checkout (503 sem o módulo), reconciliação e cron (pulam a igreja), `igrejaCobraOnline`. Para não mudar a tela, as respostas seguem com o nome `modulePayment` (evento, minhas inscrições, configuração de gateways) — agora calculado pelo plano.

## Sessão

`/auth/validate` e `/auth/admin/validate` devolvem em cada vínculo `church.modulos` (os módulos do plano da igreja), e em cada `eventTreasurers` os `modulos` da igreja do evento — o menu do tesoureiro(a) de evento segue o plano dela. A tela renova a sessão a cada navegação no painel: trocar o plano vale na navegação seguinte de quem já está logado.

## Migration

`20261012120000_planos`: cria o enum `ChurchModule`, a tabela `plans` e `churches.planId` (nula), e **apaga `churches.modulePayment`**. Depois de aplicar, nenhuma igreja tem módulo nenhum — nem cobrança online — até o super admin criar os planos e escolher um para cada igreja. Testada aplicando todas as migrations num Postgres vazio (planos, plano em uso não apaga, `SEM_COBRANCA_ONLINE`, recusa da igreja sem plano).

## Migration `20261012130000_modulos_das_configuracoes`

Tira `WHATSAPP` e `INTEGRATIONS` do enum (recria o tipo, como o Prisma gera). Antes, apaga os dois valores dos planos que os tinham — sem virar Notícias ou Tesouraria sozinhos, o que daria à igreja um módulo que ninguém escolheu. Nova em vez de editar a `20261012120000`, que já estava commitada: editar migration aplicada quebra o `prisma migrate`. Testada sobre planos com os valores antigos e no banco vazio, com a sequência inteira.

## Migration `20261012150000_cobranca_em_eventos`

Tira `ONLINE_PAYMENTS` dos planos e do enum (recria o tipo). Efeito: quem tinha Eventos sem a cobrança passa a cobrar pelo site (com gateway configurado); quem tinha a cobrança sem Eventos deixa de cobrar. Testada sobre planos com os valores antigos e no banco vazio, com a sequência inteira.

## Migration `20261012140000_valor_do_plano`

Só adiciona `plans.price` (`DECIMAL(10,2)`, padrão 0): os planos que já existem ficam gratuitos até o super admin informar o valor.

## Auditoria

`Plan` passa pelo log como "Plano" e é tabela principal.

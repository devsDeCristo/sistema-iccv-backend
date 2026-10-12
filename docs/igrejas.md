# Igrejas

`Church` é o tenant do sistema: cada igreja enxerga só os próprios eventos, as
pessoas ligadas a eles e as próprias notícias (recorte aplicado em
`src/auth/tenant.ts`, ver `docs/autenticacao.md`). Este módulo cobre cadastro,
situação (ativa/inativa), líder espiritual e o módulo de cobrança por igreja.
Tela correspondente no `ic-front`: `docs/igrejas.md`.

## Rotas

Todas sob `/churches`, autenticadas (`JwtAuthGuard`, `RolesGuard`).

| Método | Rota | Quem pode | Ação |
| --- | --- | --- | --- |
| `GET` | `/churches` | `SUPER_ADMIN_ROLES` (dev, super admin) | lista as igrejas com nome, situação, líder e contagem de eventos/administradores |
| `POST` | `/churches` | `SUPER_ADMIN_ROLES` | cria uma igreja |
| `PUT` | `/churches/:id` | `SUPER_ADMIN_ROLES` | renomeia / muda situação / troca líder |
| `DELETE` | `/churches/:id` | `SUPER_ADMIN_ROLES` | remove uma igreja sem vínculos |

Só o super admin (e o dev) escreve aqui: criar, renomear ou apagar uma igreja
mexe no recorte de todo mundo. Admin de igreja não tem rota para isso.

Arquivos: `src/church/church.controller.ts`, `src/church/church.service.ts`,
`src/church/dto/create-church.dto.ts`.

## Campos

| Campo | Tipo | Observação |
| --- | --- | --- |
| `name` | `String`, único (case-insensitive) | mínimo 3 caracteres; nome repetido responde `409 Conflict` |
| `status` | `ChurchStatus` (`ACTIVE`/`INACTIVE`) | padrão `ACTIVE` na criação; omitido na edição mantém o que já estava |
| `spiritualLeaderId` | `String?` (id de `User`) | quem responde pela igreja; `null` desfaz o vínculo, omitido mantém o atual |
| `planId` | `String?` (id de `Plan`) | o plano: quais módulos a igreja usa (ver `docs/planos.md`); `null` tira o plano (a igreja fica sem módulo nenhum), omitido na edição mantém; plano inexistente responde 400. A listagem traz `plan { id, name, modules }` |

## Situação (ativa/inativa)

- **`ACTIVE`:** aparece no filtro de igrejas da home.
- **`INACTIVE`:** a igreja continua no sistema com eventos e histórico, mas
  some do filtro de quem procura evento.
- **Igreja inativa não dá painel.** Admin e financeiro dela passam a ser
  usuários comuns ali: não entram na área de admin pela igreja nem alcançam
  dados dela. Quem tem vínculo também em outra igreja ativa continua com o
  perfil de lá, só lá. Dev e super admin não mudam.
  - **Como:** o vínculo (`UserChurchRole`) continua gravado, mas toda leitura
    de permissão o descarta (`VINCULO_VALE` em `SELECT_TENANT`,
    `src/auth/tenant.ts`).
  - **`User.role`:** salvar a igreja recalcula, na mesma transação, o perfil
    de todos que têm vínculo com ela (`recalcularPerfis`). Desativar derruba
    para usuário comum; **reativar devolve o perfil** sem ninguém refazer as
    permissões.
  - **Sessão aberta:** perde o acesso na próxima chamada. Os guards e o
    `/auth/admin/validate` releem o banco, sem confiar no token.
  - **`TEST` (implantação) continua dando painel:** é quando a igreja está
    sendo montada. Para o público ela ainda não existe: não aparece na
    inscrição (`GET /public/churches` traz só as ativas), nem no filtro da
    home, e os eventos dela ficam fora do catálogo — só quem a administra os
    vê (ver `docs/eventos.md`).
- Editar sem mandar `status` no corpo não reativa nem desativa nada — quem só
  renomeia não corre o risco de reverter uma desativação de outra pessoa.

## Líder espiritual (`vincularLider`)

Vincular alguém como `spiritualLeaderId`:

- **Vira admin automaticamente** daquela igreja: grava (ou atualiza) um
  `UserChurchRole` com perfil `ADMIN` para essa pessoa, na mesma transação do
  cadastro/edição da igreja. O `User.role` sai do recálculo da igreja: em
  igreja inativa o vínculo fica gravado, mas não dá o painel. Dev e super
  admin não são rebaixados.
- **Assina e-mails:** é o nome que aparece assinando os e-mails de confirmação
  dos eventos daquela igreja (substituiu uma assinatura fixa que saía igual
  para todas).
- **Trocar de líder não rebaixa o anterior.** Quem deixou de ser líder
  continua admin da igreja até alguém tirar essa permissão manualmente pela
  tela de usuários — perder acesso ao painel não é consequência automática de
  deixar de assinar o e-mail.
- **Validação:** o id do líder precisa existir (`400` caso contrário) — evita
  erro de chave estrangeira virando `500`.
- **`SetNull` no banco:** apagar a conta do líder não apaga a igreja; ela
  fica sem assinatura até vincularem outra pessoa.

## Cobrança online por igreja

Era o `Church.modulePayment` (com a rota `PATCH /churches/:churchId/payment-providers/module`). Hoje vem com o módulo Eventos do plano da igreja — ver `docs/planos.md`. A coluna e a rota saíram.

## Remoção

`DELETE /churches/:id` só remove igreja **sem vínculos**: se `_count.events`
ou `_count.users` (só quem está no painel — inscrito não conta) forem maiores
que zero, responde `400` listando o que ainda existe. Isso evita apagar,
sem querer, eventos, inscrições, pagamentos e check-ins em cascata
(`Event.churchId` tem `onDelete: Cascade`).

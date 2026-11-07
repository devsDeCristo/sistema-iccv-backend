# Solicitações

Módulo do plano (`ChurchModule.REQUESTS`) em que os membros pedem à igreja
equipamentos e melhorias: o louvor pede um pedestal, a mídia pede um cabo.
Aprovar pede duas confirmações — a do pastor e a de uma tesouraria da igreja —,
e o membro acompanha.

Um pedido tem um ou mais produtos (dois microfones e um cabo), e pode ser
aceito só em parte. Anexo, prioridade, valor e aviso por e-mail ainda não
existem.

## Regras

- **Quem pede:** só quem é membro de uma igreja (`User.memberChurchId`, ver
  [membros.md](membros.md)), e só para ela. A igreja sai do cadastro da pessoa
  na hora do pedido, nunca do corpo da requisição. Igreja inativa não recebe.
- **Plano:** a igreja precisa ter Solicitações no plano para receber pedido
  (`exigirModulo`) e para o admin abrir o painel (`ModuloGuard`). Sem o módulo,
  o membro não vê o item na área do participante.
- **Ministério:** um da lista fixa `MINISTERIOS` (`solicitacoes.dto.ts`):
  Louvor, Mídia, Som e iluminação, Infantil, Jovens, Recepção, Intercessão,
  Ação social, Diaconia, Ensino, Casais e Outro. Fica como texto no banco, para
  a lista crescer sem migração; a tela tem a mesma lista.
- **Produtos:** de 1 a 20 por pedido, cada um com nome (até 120), quantidade
  (1 a 999) e link opcional, na ordem em que a pessoa listou (`position`).
- **Link do produto:** opcional, até 500 caracteres, só `http://` ou
  `https://` (`IsUrl` com `require_protocol`). A tela mostra como link
  clicável, então `javascript:` e afins são recusados na entrada.
- **Situação (`ChurchRequestStatus`):** `REQUESTED` (solicitado, ao criar),
  `IN_REVIEW` (em análise), `AWAITING_TREASURY` (o pastor aprovou, falta a
  tesouraria), `AWAITING_PASTOR` (a tesouraria aprovou, falta o pastor),
  `ACCEPTED` (aceito), `PARTIALLY_ACCEPTED` (aceito parcialmente) e `REJECTED`
  (recusado).
- **Duas confirmações (desde 07/11/2026):** aprovar pede o **pastor** — o
  líder espiritual da igreja (`Church.spiritualLeaderId`, posto ao criar a
  igreja) — **e uma tesouraria** dela (vínculo `TESOURARIA` nesta igreja;
  basta uma pessoa), em qualquer ordem. Recusar basta um. O lado sai de quem
  está logado (`papel`), nunca do corpo; quem não é nenhum dos dois leva `403`.
  Cada lado decide uma vez (`409` se tentar de novo, também para outra pessoa
  da tesouraria), e decidida não volta a ser decidida.
  - **Aprovar** marca os produtos que aquele lado aprova (`produtosAceitos`;
    sem a lista, todos; nenhum é `400` — para não aceitar nenhum, recuse). O
    primeiro deixa a solicitação aguardando o outro; o segundo fecha com o
    que **os dois** aprovaram em comum: todos, aceita; alguns, aceita em
    parte; nenhum em comum, recusada.
  - **Recusar** encerra: recusada, com todos os produtos fora, mesmo que o
    outro já tenha aprovado.
  - A linha da solicitação fica travada (`SELECT … FOR UPDATE`) durante a
    decisão, numa transação interativa (a forma em array é descartada pelo
    middleware de auditoria): pastor e tesouraria decidindo ao mesmo tempo
    não deixam a solicitação presa em "aguardando".
  - Igreja sem pastor cadastrado não aprova nada: a tesouraria pode aprovar,
    mas a solicitação fica aguardando o pastor até cadastrarem um.
- **Por produto:** `pastorAccepted` e `treasuryAccepted` guardam o que cada
  lado marcou — a tela mostra ao segundo o que o primeiro liberou ou recusou.
  `accepted` é o resultado: nulo até o fim; depois, `true` só no que os dois
  aprovaram (recusada, todos `false`).
- **O que os outros fazem** (o admin que não é pastor nem tesouraria, dev e
  super admin): acompanham, põem em análise (ou de volta a solicitada) **antes
  de qualquer decisão** — depois, `409`: a situação anda pela decisão — e
  escrevem a resposta ao membro (o motivo, o prazo), que continua editável.
  Pastor e tesouraria também podem mandar a resposta junto da decisão.
- **Quem entra no painel:** o admin **e a tesouraria** da igreja
  (`ADMIN_AREA_ROLES`), além de dev e super admin. A tesouraria entrou em
  07/11/2026: o que se pede (equipamento, melhoria) passa pelo caixa. Testes
  em `solicitacoes.spec.ts`.
- **Recorte por igreja:** a rota da igreja passa pelo `ChurchTenantGuard`
  (a pessoa é admin ou tesouraria **da igreja da URL**? a tesouraria de outra
  igreja não entra), e o service ainda confere que a solicitação é dessa
  igreja: trocar o id na URL não responde pedido de outra.
- **Saída da igreja:** quem deixa de ser membro continua vendo o que pediu; o
  pedido fica com a igreja a que foi feito.
- **Sessão:** `/auth/validate` devolve `memberChurch` (`id`, `name`,
  `modulos`), ou `null` para quem não é membro de nenhuma igreja ativa. É por
  ele que a área do participante decide mostrar Solicitações.

**Notificações:** a solicitação nova avisa os admins da igreja, e a mudança de
situação avisa quem pediu — em análise e o fim (aceita, em parte, recusada);
o "aguardando" é trâmite de dentro e não avisa ([notificacoes.md](notificacoes.md)).
Na home do painel, a tarefa de solicitações sem resposta conta também as que
aguardam o pastor ou a tesouraria.

## Rotas

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/solicitacoes/minhas` | qualquer logado | as solicitações da pessoa, com a igreja |
| `POST` | `/solicitacoes` | membro de uma igreja com o módulo | `{ ministerio, titulo, descricao, produtos: [{ nome, quantidade, link? }] }` |
| `GET` | `/churches/:churchId/solicitacoes` | admin ou tesouraria da igreja | as solicitações da igreja, com quem pediu |
| `GET` | `/churches/:churchId/solicitacoes/papel` | admin ou tesouraria da igreja | `{ lado: 'PASTOR' \| 'TESOURARIA' \| null, temPastor }` — como quem está logado decide aqui |
| `PATCH` | `/churches/:churchId/solicitacoes/:id/status` | admin ou tesouraria da igreja | `{ status?, resposta? }` — `status` só `REQUESTED` ou `IN_REVIEW`, e só antes de qualquer decisão |
| `POST` | `/churches/:churchId/solicitacoes/:id/decisao` | o pastor ou a tesouraria da igreja | `{ aprova, produtosAceitos?, resposta? }` |

## Banco

`ChurchRequest` (`church_requests`): igreja, quem pediu, ministério, título,
descrição, situação, resposta e as duas decisões (`pastorDecision`,
`pastorId`, `pastorAt`; `treasuryDecision`, `treasurerId`, `treasuryAt` — a
conta apagada vira nula e não desfaz a decisão). `ChurchRequestItem`
(`church_request_items`): os produtos, com nome, quantidade, link, o que cada
lado aprovou, o resultado e a posição. Apagar a
igreja ou a conta de quem pediu apaga a solicitação e os produtos junto.

Migrations: `20261105150000_modulo_solicitacoes`;
`20261105170000_link_da_solicitacao` (o link, ainda na solicitação); e
`20261106120000_produtos_da_solicitacao`, que cria os produtos e
`PARTIALLY_ACCEPTED` e move cada solicitação que já existia para um produto
(o título e o link dela, aceito se ela estava aceita, recusado se recusada)
antes de tirar a coluna `link`. Testada num banco à parte, com solicitações
aceita e em análise: os links ficaram, e o banco bateu com o schema.
`20261107120000_duas_confirmacoes_da_solicitacao`: as duas situações de
"aguardando" e as colunas das decisões (só acrescenta; as solicitações já
decididas ficam como estavam).

Arquivos: `src/solicitacoes/` (controller, service, DTOs e
`solicitacoes.spec.ts`).

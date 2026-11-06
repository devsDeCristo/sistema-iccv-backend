# Solicitações

Módulo do plano (`ChurchModule.REQUESTS`) em que os membros pedem à igreja
equipamentos e melhorias: o louvor pede um pedestal, a mídia pede um cabo. O
admin da igreja responde mudando a situação, e o membro acompanha.

Um pedido tem um ou mais produtos (dois microfones e um cabo), e o admin pode
aceitar só parte deles. Anexo, prioridade, valor e aviso por e-mail ainda não
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
  `IN_REVIEW` (em análise), `REJECTED` (recusado), `ACCEPTED` (aceito) e
  `PARTIALLY_ACCEPTED` (aceito parcialmente). O admin pode pôr qualquer uma, a
  qualquer momento, com uma resposta opcional (o motivo, o prazo), que o
  membro lê junto.
- **Decisão por produto (`ChurchRequestItem.accepted`):** sai da situação.
  Aceita: todos `true`; recusada: todos `false`; solicitada ou em análise:
  todos nulos (sem decisão); aceita parcialmente: `true` os de
  `produtosAceitos`, `false` os outros. Na parcial, os ids precisam ser
  produtos deste pedido e ser alguns: nenhum seria recusada, todos seria
  aceita (`400` nos dois casos). A situação e as decisões mudam numa
  transação interativa (a forma em array é descartada pelo middleware de
  auditoria).
- **Recorte por igreja:** a rota do admin passa pelo `ChurchTenantGuard`
  (administra a igreja da URL?), e o service ainda confere que a solicitação é
  dessa igreja: trocar o id na URL não responde pedido de outra.
- **Saída da igreja:** quem deixa de ser membro continua vendo o que pediu; o
  pedido fica com a igreja a que foi feito.
- **Sessão:** `/auth/validate` devolve `memberChurch` (`id`, `name`,
  `modulos`), ou `null` para quem não é membro de nenhuma igreja ativa. É por
  ele que a área do participante decide mostrar Solicitações.

**Notificações:** a solicitação nova avisa os admins da igreja, e cada
mudança de situação avisa quem pediu ([notificacoes.md](notificacoes.md)).

## Rotas

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/solicitacoes/minhas` | qualquer logado | as solicitações da pessoa, com a igreja |
| `POST` | `/solicitacoes` | membro de uma igreja com o módulo | `{ ministerio, titulo, descricao, produtos: [{ nome, quantidade, link? }] }` |
| `GET` | `/churches/:churchId/solicitacoes` | admin da igreja | as solicitações da igreja, com quem pediu |
| `PATCH` | `/churches/:churchId/solicitacoes/:id/status` | admin da igreja | `{ status, resposta?, produtosAceitos? }` (os ids, só na parcial) |

## Banco

`ChurchRequest` (`church_requests`): igreja, quem pediu, ministério, título,
descrição, situação e resposta. `ChurchRequestItem` (`church_request_items`):
os produtos, com nome, quantidade, link, a decisão e a posição. Apagar a
igreja ou a conta de quem pediu apaga a solicitação e os produtos junto.

Migrations: `20261105150000_modulo_solicitacoes`;
`20261105170000_link_da_solicitacao` (o link, ainda na solicitação); e
`20261106120000_produtos_da_solicitacao`, que cria os produtos e
`PARTIALLY_ACCEPTED` e move cada solicitação que já existia para um produto
(o título e o link dela, aceito se ela estava aceita, recusado se recusada)
antes de tirar a coluna `link`. Testada num banco à parte, com solicitações
aceita e em análise: os links ficaram, e o banco bateu com o schema.

Arquivos: `src/solicitacoes/` (controller, service, DTOs e
`solicitacoes.spec.ts`).

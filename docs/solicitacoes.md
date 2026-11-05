# Solicitações

Módulo do plano (`ChurchModule.REQUESTS`) em que os membros pedem à igreja
equipamentos e melhorias: o louvor pede um pedestal, a mídia pede um cabo. O
admin da igreja responde mudando a situação, e o membro acompanha.

É um esqueleto: pedido, situação e resposta. Anexo, prioridade, valor e aviso
por e-mail ainda não existem.

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
- **Link do produto:** opcional, até 500 caracteres, só `http://` ou
  `https://` (`IsUrl` com `require_protocol`). A tela mostra como link
  clicável, então `javascript:` e afins são recusados na entrada.
- **Situação (`ChurchRequestStatus`):** `REQUESTED` (solicitado, ao criar),
  `IN_REVIEW` (em análise), `REJECTED` (recusado) e `ACCEPTED` (aceito). O admin
  pode pôr qualquer uma, a qualquer momento, com uma resposta opcional (o
  motivo, o prazo), que o membro lê junto.
- **Recorte por igreja:** a rota do admin passa pelo `ChurchTenantGuard`
  (administra a igreja da URL?), e o service ainda confere que a solicitação é
  dessa igreja: trocar o id na URL não responde pedido de outra.
- **Saída da igreja:** quem deixa de ser membro continua vendo o que pediu; o
  pedido fica com a igreja a que foi feito.
- **Sessão:** `/auth/validate` devolve `memberChurch` (`id`, `name`,
  `modulos`), ou `null` para quem não é membro de nenhuma igreja ativa. É por
  ele que a área do participante decide mostrar Solicitações.

## Rotas

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/solicitacoes/minhas` | qualquer logado | as solicitações da pessoa, com a igreja |
| `POST` | `/solicitacoes` | membro de uma igreja com o módulo | `{ ministerio, titulo, descricao, link? }` |
| `GET` | `/churches/:churchId/solicitacoes` | admin da igreja | as solicitações da igreja, com quem pediu |
| `PATCH` | `/churches/:churchId/solicitacoes/:id/status` | admin da igreja | `{ status, resposta? }` |

## Banco

`ChurchRequest` (`church_requests`): igreja, quem pediu, ministério, título,
descrição, link do produto, situação e resposta. Apagar a igreja ou a conta de
quem pediu apaga a solicitação junto. Migrations
`20261105150000_modulo_solicitacoes` e `20261105170000_link_da_solicitacao`
(o link veio depois, numa migration própria).

Arquivos: `src/solicitacoes/` (controller, service, DTOs e
`solicitacoes.spec.ts`).

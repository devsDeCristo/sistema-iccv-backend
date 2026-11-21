# Solicitações — correções e melhorias

Levantamento do fluxo inteiro do módulo em 21/11/2026 (último commit do
módulo: `7ad8db3`). O que existe hoje está em
[solicitacoes.md](solicitacoes.md); a tela, em `ic-front` (o frontend), em
`src/features/solicitacoes` e `src/pages/{,admin/}solicitacoes`. A ordem é
a de prioridade: primeiro as correções, depois as melhorias.

✅ feito · ⏳ pendente

> **Correções 1 a 5 e melhorias 7 a 10 implementadas em 21/11/2026.** A 6
> (quem pediu aprovar o próprio pedido) segue em aberto, à espera da decisão
> de regra de negócio. Na 8, só a recusa explícita pede o motivo; a recusa
> por falta de produto em comum não. Na 9, a aba se chama "Sua vez". Junto
> veio uma regra nova: a tesouraria só é obrigatória na igreja com o módulo
> Tesouraria ou com alguém no perfil (ver [solicitacoes.md](solicitacoes.md)).
>
> **Melhorias 11 e 13 a 16 implementadas em 21/11/2026.** Na 11, a caixa do
> produto que o outro lado recusou fica desabilitada. Na 13, o "Outro" fica
> numa coluna nova (`ministryOther`), e `ministry` segue "Outro". Na 16, a
> lista do painel vem paginada (`page`/`limit`, como os logs), com as
> contagens das abas na mesma resposta; ordena só pela data e filtra só pelo
> ministério. Falta a 12 (o membro cancelar).

## Correções

### ✅ 1. Texto só com espaços é gravado vazio

O `@IsNotEmpty` aceita `"   "`, e o `.trim()` do service
(`criar()`, em `solicitacoes.service.ts`) grava `""` em `title`,
`description` e no `name` dos produtos. A tela bloqueia, mas uma chamada
direta à API passa.

- Nos campos `titulo` e `descricao` do `CriarSolicitacaoDto` e no `nome` do
  `ProdutoDaSolicitacaoDto`, aplicar o trim antes da validação, com o mesmo
  `@Transform` que já existe em `src/user/dto/bloquear-usuario.dto.ts`:
  `@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))`.
- Teste: `titulo: '   '` dá 400.

### ✅ 2. Disputa entre `mudarStatus` e `decidir`

`mudarStatus` lê a situação e só depois grava, sem trava. Se o admin põe a
solicitação em análise no mesmo instante em que o pastor aprova, a gravação
do admin sobrescreve `AWAITING_TREASURY` com `IN_REVIEW`, mesmo com
`pastorDecision = true`.

- Gravar a situação com `updateMany`, com a condição no `where`:
  `{ id, churchId, status: { in: ANTES_DA_DECISAO } }`. Se `count === 0`,
  devolver 409 com a mensagem que já existe.
- Só a resposta, sem mudar a situação, continua sendo um `update` comum.

### ✅ 3. Solicitações sem nome no log de atividades

`ChurchRequest` e `ChurchRequestItem` não estão em `MODEL_LABELS` nem em
`MAIN_MODELS` (`src/logs/log-labels.ts`), então o painel de logs mostra o
nome cru do model. É o mesmo ajuste que foi feito para Oportunidades.

- `ChurchRequest: 'Solicitação'` e `ChurchRequestItem: 'Produto da solicitação'`.
- `ChurchRequest` entra em `MAIN_MODELS`.

### ✅ 4. O modal do painel trabalha com uma cópia velha

Na página do painel (`pages/admin/solicitacoes/index.tsx`), o estado
`aberta` guarda o objeto inteiro da solicitação. Se o refetch da lista
traz uma decisão nova, o modal continua com a antiga, e quem clica em
Aprovar leva um 409 ("já decidiu").

- Guardar só o id (`abertaId`) e buscar a solicitação em `data`.
- No `ModalDaSolicitacao`, o `useEffect` que preenche situação, resposta e
  produtos marcados passa a depender de `s?.id` e `s?.updatedAt`, e não de
  `s`. Senão cada refetch apaga o que a pessoa já digitou.

### ✅ 5. O papel do usuário só carrega depois que o modal abre

`usePapelNasSolicitacoes` é chamado dentro do modal. Quando o papel chega,
o `useEffect` roda de novo (`lado` e `outra` mudam) e apaga a resposta que
já foi digitada, e o bloco de decisão aparece de repente.

- Buscar o papel na página, uma vez por igreja, e passar `papel` como prop
  ao modal.
- Isso também viabiliza o filtro "Aguardando você" (seção 9).

### ⏳ 6. Quem pediu pode aprovar o próprio pedido

Se a pessoa que pediu é o pastor ou da tesouraria, `decidir` aceita a
decisão dela.

- **Em aberto:** é regra de negócio. Se não deve poder, basta, no
  `decidir`, um `if (atual.requesterId === userId)` com 403 ("Quem pediu
  não decide o próprio pedido"). Na tela, `possoDecidir` passa a considerar
  `s.requester.id`.
- Atenção: numa igreja pequena, o pastor que pede para o próprio ministério
  ficaria sem ninguém para aprovar do lado dele.

## Melhorias

### ✅ 7. Detalhes da solicitação para o membro

O card corta a descrição e a resposta em 3 linhas e mostra só 3 produtos
("+ N produtos" não é clicável). Não há tela de detalhe: o membro não
consegue ler a própria solicitação inteira.

- O card inteiro clicável (`ButtonBase`) abre um modal só de leitura: o
  pedido inteiro, todos os produtos com o resultado (✓/✗) e a resposta
  inteira.
- Reaproveitar `ListaDeProdutos` (sem `limite`).

### ✅ 8. Exigir resposta ao recusar

Hoje a recusa pode ir sem motivo, e o membro recebe só "Solicitação
recusada". O mesmo acontece quando a solicitação fecha recusada porque
pastor e tesouraria não aprovaram nenhum produto em comum.

- No `decidir`, quando `!dto.aprova` e a resposta está vazia: 400 ("Diga
  o motivo da recusa").
- Na tela, a confirmação da recusa só habilita "Sim, recusar" com a
  resposta preenchida.
- **Em aberto:** a recusa por falta de produto em comum também exige
  resposta de quem decide em segundo?

### ✅ 9. Filtro "Aguardando você" no painel

Com o papel buscado na página (seção 5), dá para destacar o que depende do
pastor ou da tesouraria que está logado. Hoje é preciso abrir solicitação
por solicitação.

- Aba (ou chip de filtro) "Aguardando você": a solicitação não está
  decidida (`RESPONDIDA`) e a decisão do lado de quem está logado é `null`.
- Opcional: contagem dessa aba na pendência da home.

### ✅ 10. Aviso de igreja sem tesouraria

`papel` devolve `temPastor`, mas não verifica se existe alguém na
tesouraria. Sem tesouraria, nada é aprovado (fica em `AWAITING_TREASURY`
para sempre) e nenhum aviso aparece.

- `papel` devolve também `temTesouraria`: algum `UserChurchRole` com
  `role: TESOURARIA` nesta igreja.
- O modal mostra o mesmo `Alert` de "sem pastor" para a tesouraria.

### ✅ 11. Quem decide em segundo marca produto que não entra

Quem decide em segundo pode marcar um produto que o primeiro recusou. O
botão diz "Aprovar tudo", mas o resultado vai ser parcial.

- Desabilitar o checkbox dos produtos que o outro lado recusou, com a
  etiqueta já existente ("Pastor ✗"), ou mostrar "vai entrar X de Y" no
  botão.

### ⏳ 12. O membro cancela a solicitação

O membro não consegue desistir do pedido, e o painel acumula pedidos que
ninguém quer mais.

- Novo status `CANCELED` (migration no enum `ChurchRequestStatus`), e
  `PATCH /solicitacoes/:id/cancelar` para quem pediu, só em `REQUESTED` ou
  `IN_REVIEW`.
- No painel, a aba "Recusadas" vira "Encerradas" (recusadas e canceladas),
  ou ganha uma aba própria.
- **Em aberto:** cancelar também depois da primeira aprovação?

### ✅ 13. Ministério "Outro" com descrição

Com "Outro", ninguém sabe que ministério está pedindo.

- Ao escolher "Outro", um campo de texto curto obrigatório (até 60
  caracteres). Gravar em `ministry` como `Outro: <texto>`, sem migration,
  ou em uma coluna nova `ministryOther`.

### ✅ 14. Ministério em coluna própria na lista do painel

O ministério aparece dentro da célula de quem pediu, então o DataGrid não
ordena nem filtra por ele.

- Coluna `ministry` própria em `ListaDaIgreja`, com o ícone do ministério.
  O filtro nativo do DataGrid passa a funcionar.

### ✅ 15. Confirmar antes de descartar a nova solicitação

Clicar fora do modal ou em Cancelar perde o formulário preenchido sem
perguntar.

- Com algo preenchido, perguntar antes de fechar ("Descartar a
  solicitação?"), dentro do próprio modal, como a confirmação da recusa.

### ✅ 16. Paginação na API do painel

`daIgreja` devolve todas as solicitações da igreja, com todos os produtos.
Não é urgente, mas a lista cresce para sempre.

- Filtro por etapa (`?etapa=novas`) e paginação no servidor; as contagens
  das abas vêm de um `groupBy` por status.

## Pequenos ajustes

- ✅ `modalDaSolicitacao.tsx`: o `import { ListaDeProdutos }` está no meio
  do arquivo, depois do componente `Confirmacao`.
- ⏳ `modalNovaSolicitacao.tsx`: os produtos usam `key={i}`. Ao remover um
  produto do meio da lista, o foco pula de campo. Usar um id gerado na
  criação do produto (`crypto.randomUUID()`).
- ⏳ `DecidirDto.produtosAceitos`: falta `@ArrayMaxSize(20)`, o mesmo teto da
  criação.

## Para mais adiante

- **Depois de aceita, o fluxo acaba.** Não existe uma situação de
  "comprado/entregue", nem ligação com o lançamento na tesouraria
  (`FinancialEntry`).
- **Aprovar uma quantidade menor.** Por exemplo, 1 de 2 microfones. Pede
  uma quantidade aprovada por lado em `ChurchRequestItem`.

## Já está certo

Não precisa mexer:

- a trava `FOR UPDATE` no `decidir`, contra pastor e tesouraria aprovando
  ao mesmo tempo;
- a conferência de que a solicitação é da igreja da URL (`where: { id, churchId }`);
- o lado da decisão, que sai de quem está logado e nunca do corpo;
- o líder espiritual ser sempre admin da igreja (`assertLiderSegueAdmin`).

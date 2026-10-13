# Tesouraria (dizimistas, livro-caixa e Pluggy)

Módulo de tesouraria de cada igreja: quem dizima nela (**dizimistas**) e o livro-caixa (**lançamentos**), com entradas e saídas lançadas à mão e importadas do extrato dos bancos pela Pluggy.

Código: `src/tesouraria` (controller, `DizimistasService`, `LancamentosService`, `ConciliacaoService`, `PlanilhaService`, `categorias.ts`, `conciliacao.ts`, `planilha.ts`) e `src/pluggy/pluggy.service.ts` (leitura do extrato).

## Quem acessa

- `@Roles(...ADMIN_AREA_ROLES)` + `ChurchTenantGuard`, como a Pluggy: dev, super admin, e admin ou tesouraria **da igreja da rota**. A tesouraria de uma igreja não lê o caixa da outra trocando o `:churchId`.
- Além do guard, todo acesso a um registro é pela igreja da rota junto: um lançamento de outra igreja, ou uma pessoa que não é membro desta, responde 404 e não altera nada.
- Ligar um lançamento a um dizimista exige que a pessoa seja **membro** desta igreja (400 caso contrário).

## Tesoureiro(a) de evento (`EventTreasurer`)

O perfil da igreja que cuida do caixa se chamava "Financeiro" e agora é **Tesouraria** (`Role.TESOURARIA`, o mesmo 3 em `User.role` e `UserChurchRole.role` — nada mudou no banco). Além dele há o tesoureiro(a) **de evento**: quem cuida da tesouraria de um evento sem ser admin nem tesouraria da igreja.

- **Modelo:** `EventTreasurer` (tabela `event_treasurers`), chave `(eventId, userId)`, `kind` (`BASICO` ou `COMPLETO`), `createdById` (o admin que deu o vínculo). Apagar o evento ou a pessoa apaga o vínculo. Migration `20261012150000_event_treasurers` — só cria a tabela e o enum; **não foi aplicada em banco nenhum**.
- **Não é perfil:** não muda `User.role` nem entra em `perfilEfetivo`. Quem é só tesoureiro de evento continua usuário comum para o resto do sistema.
- **Básico** vê só a aba Tesouraria dos detalhes do evento; **completo** vê também Tesouraria › Eventos no painel (hoje ainda de exemplo, só no front).
- **Vínculo de igreja desativada não vale**, como o de igreja (`VINCULO_VALE`).
- **O acesso** (`src/auth/tesoureiro-do-evento.ts`):
  - a rota que aceita o tesoureiro diz isso com `@AceitaTesoureiroDoEvento()`. Sem o decorator, nada muda: a rota continua fechada para ele;
  - `RolesGuard`: fora dos perfis do `@Roles`, deixa passar quem tem algum vínculo de tesoureiro, só em rota com o decorator;
  - `EventTenantGuard`: quem passou assim só entra **no evento dele** (pelo `:idEvent`, `:eventId` ou pelo evento do `:paymentId`). Sem isto o usuário comum caía no "não é recortado" e alcançava o evento de qualquer igreja — os testes fecham esse caso. Também deixa entrar a tesouraria (ou o admin) de outra igreja que é tesoureira deste evento;
  - `ChurchTenantGuard` (rotas `/churches/:churchId/...`): quem não tem perfil na igreja da rota só passa se a rota tem o decorator **e** ele é tesoureiro de um evento **desta** igreja (`tesoureiroNaIgreja`). Com teste (`church-tenant.guard.spec.ts`);
  - rotas com o decorator: `GET events/:idEvent/payments`, `GET events/:idEvent/payments/logs`, `PUT payments/:paymentId` e `PATCH payments/:paymentId/refund` (a aba Tesouraria), e `GET churches/:churchId/membros` (a lista de membros, só consulta). A entrega de produtos é da aba Pedidos, e fica de fora.
- **Eventos no painel:** `GET /events?painel=true` traz os eventos das igrejas da pessoa **e** os de que ela é tesoureira; quem não tem igreja nenhuma fica só com os dele (antes, o usuário comum recebia o catálogo inteiro com `painel=true`). `GET /events/:id?painel=true` também abre o evento de que ela é tesoureira.
- **Login:** o `login` e o `GET /auth/admin/validate` (e o `/auth/validate`) mandam `eventTreasurers` (`eventId`, `eventName`, `churchId`, `churchName`, `modulos` — os do plano da igreja do evento —, `kind`). O painel admite quem tem perfil de painel **ou** algum vínculo de tesoureiro.
- **Quem dá o vínculo** (`src/event/tesoureiros.controller.ts`, `events/:idEvent/tesoureiros`):

| Rota                                          | Quem                                   | O que faz                                                                                                 |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /events/:idEvent/tesoureiros`            | `ADMIN_AREA_ROLES` da igreja do evento | os tesoureiros: id, nome, e-mail, foto e `kind`                                                           |
| `PUT /events/:idEvent/tesoureiros/:userId`    | `ADMIN_ROLES` da igreja do evento      | dá o vínculo ou troca o tipo (`{ kind }`); recusa (400) quem já é admin ou tesouraria da igreja do evento |
| `DELETE /events/:idEvent/tesoureiros/:userId` | `ADMIN_ROLES` da igreja do evento      | tira o vínculo                                                                                            |

O módulo do plano é o de Eventos (`ModuloGuard`). A pessoa se escolhe pela busca de Membros (`GET /churches/:churchId/membros/busca`). O log de auditoria chama a tabela de "Tesoureiro(a) do evento".

## Rotas (`/churches/:churchId/tesouraria`)

| Rota                                                            | O que faz                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET dizimistas?ano=`                                           | Todos os membros da igreja, com os números do ano (padrão: o atual)                       |
| `PATCH dizimistas/:userId`                                      | `{ titheAmount }`: o valor do dízimo do membro (`null` tira)                              |
| `POST dizimistas/planilha/previa`                               | **Só admin.** `{ nomes }`: quem é cada nome da planilha de dízimos. Não grava             |
| `POST dizimistas/planilha`                                      | **Só admin.** `{ ano, linhas: [{ nome, userId?, valores[12] }] }`: importa a planilha     |
| `GET lancamentos?de&ate&type&category&source&busca&conciliacao` | Lançamentos do período, com resumo; `conciliacao=conciliado\|pendente` filtra pelo status |
| `POST lancamentos`                                              | Lançamento manual                                                                         |
| `PATCH lancamentos/:id`                                         | Edita (no importado, só categoria, descrição e dizimista)                                 |
| `DELETE lancamentos/:id`                                        | Apaga o manual; o importado não                                                           |
| `POST lancamentos/importar`                                     | Importa o extrato da Pluggy                                                               |
| `GET conciliacao?de&ate`                                        | As linhas do diff banco × manual do período, com resumo                                   |
| `POST conciliacao`                                              | `{ bancoId, manualId }`: concilia um par                                                  |
| `POST conciliacao/sugeridos?de&ate`                             | Concilia todos os pares sugeridos do período; devolve `{ conciliados }`                   |
| `DELETE conciliacao/:manualId`                                  | Desfaz o par                                                                              |
| `PUT conciliacao/:manualId/nao-consta`                          | Marca o manual como "não consta no banco"                                                 |
| `DELETE conciliacao/:manualId/nao-consta`                       | Devolve o manual para a conciliação                                                       |

As tesourarias de evento e de congregação têm rotas próprias (`TesourariasController`), na seção abaixo.

## Dizimistas são os membros

- **Não há cadastro de dizimista:** todo membro da igreja (`User.memberChurchId`, ver `docs/membros.md`) é um dizimista em potencial. A lista de dizimistas é a lista de membros; quem entra e sai é o admin, em Membros. A tesouraria não adiciona nem tira ninguém.
- **Valor do dízimo** (`User.titheAmount`, `Decimal(12,2)`, opcional): o dízimo combinado com o membro, na igreja de que ele é membro (uma só). É o que a importação usa, junto com o CPF, para separar dízimo de oferta (ver abaixo). `PATCH dizimistas/:userId` define; `null` tira. Só vale para membro desta igreja (404 caso contrário). Deixar de ser membro zera o valor.
- **Números do ano** (`listar`): saem dos lançamentos `INCOME` de categoria `TITHE` desta igreja ligados à pessoa, manuais ou importados. Por membro: total no ano, quanto em cada mês (`porMes`, janeiro a dezembro — a visão por mês da tela), meses do ano com dízimo (1 a 12) e o último dízimo (de qualquer ano). No resumo: membros, quantos dizimaram no mês e no ano, total do mês e do ano, e o total da igreja em cada mês (`porMes`).
- Apagar a conta do usuário não apaga o dinheiro: o lançamento fica com `userId` nulo (`SetNull`).

## Lançamentos (`FinancialEntry`, tabela `financial_entries`)

- `type` (`INCOME`/`EXPENSE`), `category`, `amount`, `date`, `description`, `method` (Pix, dinheiro, cartão, transferência, boleto, outra), `userId` (dizimista ou quem contribuiu), `source` (`MANUAL`/`PLUGGY`), e do extrato: `externalId`, `bankAccount` ("Sicredi · Conta corrente"), `payerName`.
- **`amount` é `Decimal(12,2)`**, e não `Float` como os pagamentos de evento: o livro-caixa vive de somas (saldo do mês, total do ano), e soma de `Float` acumula erro de centavo. Sempre positivo; o sinal é o `type`. A API devolve número.
- **`date` é `@db.Date`** (dia, sem hora). Entra e sai como `"AAAA-MM-DD"`, sem passar por fuso.
- **Categorias** por tipo (`CATEGORIAS_POR_TIPO`): entradas — dízimo, oferta, doação, evento, outra entrada; saídas — água/luz/internet, aluguel, manutenção, salários e ajudas de custo, materiais, missões e ação social, evento, tarifas bancárias, outra saída. Categoria de um tipo num lançamento do outro é recusada (400).
- **Lista** (`listar`): período padrão do dia 1 do mês até hoje (em Brasília); filtros de tipo, categoria, origem e busca (descrição, pagador ou nome do dizimista). Teto de 5.000 linhas (`cortado: true` avisa a tela). O **resumo** (entradas, saídas, saldo, dízimos) é do **período inteiro**, ignorando os outros filtros de propósito: os cards dizem quanto entrou e saiu, não quanto há na tabela filtrada.
- **Importado do banco:** valor, data, tipo e forma são o que o extrato diz e não mudam (400 se tentar); categoria, descrição e dizimista sim. **Não se apaga**: o `externalId` dele é o que impede a mesma transação de voltar na próxima importação.

## Importação do extrato (Pluggy)

`POST lancamentos/importar` → `LancamentosService.importar` → `PluggyService.transacoes`.

- **Janela:** da última leitura (`PluggyIntegration.lastSyncAt`) menos 7 dias até hoje; na primeira, os últimos 90 dias. A sobreposição pega a transação que estava pendente na leitura anterior e só apareceu lançada depois.
- **O que entra:** as transações **lançadas** (`status` diferente de `PENDING`) das contas do tipo `BANK` (corrente e poupança) de cada Item ID. Conta de cartão de crédito fica de fora: a fatura já sai da conta corrente como débito, e importar as compras contaria a despesa duas vezes.
- **Sem duplicar:** `externalId` (id da transação na Pluggy) é único por igreja, e a gravação usa `createMany` com `skipDuplicates`. Rodar de novo sobre o mesmo período não duplica nada; a resposta diz quantas foram lidas, importadas e quantas já existiam.
- **Como vira lançamento** (`lancamentoDaTransacao`, em `categorias.ts`, com teste):
  - Crédito cujo CPF do pagador (`paymentData.payer.documentNumber`) é de um **membro** da igreja → ligado a ele, e o **valor** decide a categoria:

    - igual ao valor do dízimo dele (`titheAmount`, comparado ao centavo) → `TITHE`;
    - outro valor → `OFFERING` (oferta), ainda ligada a ele;
    - dizimista sem valor cadastrado → `TITHE` (o Pix do dízimo é o caso comum).

    Continua sendo um palpite: quem manda dízimo e oferta juntos num Pix só, ou mudou o valor do dízimo sem atualizar o cadastro, cai em oferta — a tesouraria corrige a categoria (e o valor no cadastro).

  - Outro crédito → "outra entrada", sem pessoa.
  - Débito → categoria pela categoria da Pluggy quando há equivalente claro (tarifas → tarifas bancárias; luz, água, telefone, internet → água/luz/internet; aluguel; salários); o resto, "outra saída".
  - Forma: Pix → Pix; TED/DOC/TEF → transferência; boleto → boleto; o resto fica vazio.
  - Data: o dia da transação **em Brasília** (uma transação às 01:30 UTC do dia 4 é do dia 3).
- Credencial recusada ou integração desligada → 400 com a mensagem; falha de rede ou da Pluggy → 502 ("tente de novo em alguns minutos"). Depois de importar, `lastSyncAt` é atualizado (o card da integração mostra "Última leitura há…").
- Por enquanto a importação é **por botão**: não há webhook da Pluggy nem rotina agendada.
- **A conta de cada movimento** (`account`) vem da **divisão dos bancos** da Pluggy (`splitByTreasury` + `itemAccounts`, `contaDoBanco`): sem divisão, tudo é da Administrativa; com ela, cada banco (Item) é da Administrativa, de Eventos ou de Congregações, e o movimento guarda o banco de onde veio (`bankItemId`). Movimento das contas de Eventos e de Congregações **não** vira dízimo nem fica ligado a membro (`OTHER_INCOME`/`OTHER_EXPENSE`): a categoria dele é a da alocação. Salvar a divisão reconta a conta dos movimentos já importados pelo banco de onde vieram (os de antes do `bankItemId` ficam na Administrativa).

## Planilha de dízimos

Para trazer o histórico de quem já dizimava antes do sistema: uma planilha com uma linha por pessoa e o total de cada mês (jan a dez). A tela lê o arquivo (xlsx, no navegador) e manda só nomes e números.

- **Só o admin** da igreja (`@Roles(...ADMIN_ROLES)` nas duas rotas, por cima do `ADMIN_AREA_ROLES` do controller): a importação coloca gente como membro, e isso é do admin, como em Membros.
- **Quem é cada nome** (`previa`, `planilha.ts`, com teste): busca no sistema todo quem tem **2 ou mais palavras do nome em comum** — palavra inteira ("ana" não acha "Mariana"), **sem acento dos dois lados** ("Miquéias" acha "Miqueias", "Fatima" acha "Fátima"), sem conectivos ("de", "da", "dos"…) nem iniciais soltas. É SQL (`translate` tira o acento, `\m…\M` é o limite de palavra do Postgres): o `contains` do Prisma não ignora acento. Os com mais palavras em comum vêm primeiro (até 8). "Fulano / Cônjuge" busca pelo primeiro nome. Nome de uma palavra só ("DJALMA") não busca. Escolhe sozinho: o **mesmo nome** (as mesmas palavras), preferindo o membro desta igreja entre homônimos (`exato`); sem o mesmo nome, o único candidato em que um nome cabe inteiro no outro, aceitando **um erro de digitação por palavra** de 4+ letras (uma letra trocada, a mais ou a menos: "Eduarda Dâmares Lima Diogenes" casa com "Eduarda Dâmaris Lima Diógenes"; "Miqueias Sousa" cabe em "Miquéias Abnadabe Ferreira Sousa"); sem nenhum assim, o favorito claro (mesmo primeiro nome, 3+ palavras em comum e mais que todos os outros). Esses dois vêm marcados para conferir. Mais de um empatado, ou nenhum, a pessoa escolhe. A busca no banco ainda pede 2 palavras iguais sem acento; a tolerância a erro vale para escolher entre os achados. Membro de outra igreja nunca é escolhido. Os candidatos voltam como na busca de Membros (CPF pela metade, de qual igreja já são membros).
- **Importar** (`importar`): cada mês com valor vira um lançamento `INCOME`/`TITHE`, `MANUAL`, no **dia 1º do mês**, ligado ao dizimista, com o nome da planilha em `payerName` e descrição "Dízimo MM/AAAA — Nome da planilha (planilha)". Quem não é membro de nenhuma igreja **vira membro desta** (o mesmo `tornarMembro` atômico de Membros); membro de outra igreja fica de fora (`ignorados`, com o motivo). Sem `userId`, a linha é **sem vínculo** (quem não é usuário do sistema, ou a linha "Anônimo"): o dízimo entra sem dizimista, só com o nome da planilha na descrição e no pagador. A mesma pessoa em duas linhas soma no mês.
- **Não duplica:** `externalId` = `planilha:<userId>:<ano>-<mês>` (ou `planilha:anonimo:<nome>:...`), com `skipDuplicates`. Importar a mesma planilha de novo não cria nada; o mês já importado fica como está, mesmo com o valor mudado na planilha (corrige-se no lançamento). Resposta: `{ lancamentos, jaExistiam, novosMembros, ignorados }`.
- Não sabe de dízimo do mesmo mês lançado de outro jeito (à mão ou pelo banco): importar a planilha de um mês que já foi lançado conta duas vezes. Os lançamentos da planilha são manuais e aparecem na Conciliação como "só manual" (o total do mês não casa com os Pix um a um).

## Conciliação

**O banco é a fonte; o lançamento manual fica para o que o banco não vê** (o dinheiro em espécie). Os dois contam nos totais. Quando o mesmo dinheiro está duas vezes — o Pix que veio do extrato (`PLUGGY`) e o lançamento que alguém fez à mão (`MANUAL`) —, conciliar liga os dois. O manual que nunca vai aparecer no extrato é marcado **"não consta no banco"**.

- **Modelo:** o manual aponta para o do banco — `reconciledWithId` (único: uma transação do banco concilia com um manual só; `SetNull` se o do banco sumir), `reconciledAt`, `reconciledById`. O status `conciliado` de um lançamento (na lista e no filtro) vale para as duas pontas.
- **Conta uma vez:** o manual conciliado sai dos totais — o resumo de Lançamentos e os números de Dizimistas ignoram `reconciledWithId` preenchido; vale o do banco. Na tabela os dois continuam aparecendo.
- **Conciliar** (`conciliar`): os dois da igreja da rota (404), banco do lado `PLUGGY` e manual do lado `MANUAL` (400), mesmo tipo (400), nenhum dos dois já conciliado (409; a corrida entre duas pessoas também dá 409 pelo índice único). Valor e data **podem** diferir: valem os do extrato. O do banco **herda a categoria e o dizimista** do manual — é a classificação que a pessoa deu, e o dízimo passa a contar pelo do banco.
- **Desfazer:** o manual volta a contar; a categoria que o banco herdou fica.
- **Sugestão** (`sugerirPares`, em `conciliacao.ts`, com teste): entre os pendentes, mesmo tipo, mesmo valor ao centavo e datas a até 3 dias. Cada lançamento entra em um par só; com mais de um candidato vence a data mais próxima e, no empate, o mesmo dizimista. Não grava nada: "conciliar sugestões" grava os pares da lista.
- **Não consta no banco** (`marcarNaoConsta`): `PUT conciliacao/:manualId/nao-consta` marca, `DELETE` desmarca. Só lançamento `MANUAL` (400) e não conciliado (409). Grava `notInBankAt` e `notInBankById`. O marcado sai da fila e das sugestões, e do filtro "pendente" de Lançamentos; **continua nos totais**, como todo manual sem par. Conciliar um marcado apaga a marca (o banco mostrou que constava). Na tela, `naoConstaNoBanco` em cada lançamento.
- **Linhas** (`listar`): `sugerido`, `so_banco`, `so_manual`, `nao_consta` e `conciliado`, nessa ordem de prioridade e da data mais recente. Um par conciliado aparece se qualquer ponta cai no período. Resumo: quantos de cada (`naoConsta` inclusive) e o saldo (entradas − saídas) do que está só de um lado.

## Tesourarias de evento e de congregação

`TesourariasService` / `TesourariasController`, em `/churches/:churchId/tesouraria/tesourarias`. O dinheiro é todo da igreja; a tesouraria é o centro de custo, e o extrato da conta dela é **distribuído** (alocado) entre as tesourarias.

- **A conta:** com os bancos divididos e algum banco de Eventos (ou de Congregações), as tesourarias desse tipo distribuem dessa conta (`temBancoProprio`). Sem isso, distribuem da **conta única**, a da Administrativa: o que vai para um evento ou congregação **sai dos totais da Administrativa** (o resumo de Lançamentos desconta as alocações) e da conciliação de lá (movimento com alocação não aparece como pendente). O que a Administrativa já conciliou com um manual não é oferecido. O "a distribuir" olha 365 dias para trás.
- **Modelo:** `Treasury` (tipo `EVENT` ou `CONGREGATION`; o evento do sistema — um por tesouraria —, ou nome e data do evento fora do sistema, ou nome e local da congregação, que nasce com ela; fechamento: quando, por quem), `TreasuryAllocation` (movimento, tesouraria, valor, categoria; uma por movimento e tesouraria — trazer de novo soma), `TreasuryEntry` (o lançamento manual do evento) e `TreasuryPaymentLink` (o pagamento do evento diante do extrato: conciliado com um movimento ou "não consta no banco").
- **Lançamentos do sistema (só no evento):** os **pagamentos pagos** (`PAID`, de valor maior que zero — a inscrição gratuita não tem dinheiro para conciliar) do evento da tesouraria — inscrição ("Ingressos") ou só produtos ("Produtos"), com o nome de quem pagou e a forma — e os manuais da tesouraria. A data do pagamento é a da última mudança dele (`updatedAt`): o pagamento não guarda quando foi pago. Na tela, o id é `pagamento:<id>` ou `manual:<id>`.
- **Conciliar:** um movimento com um ou vários lançamentos do sistema; a soma (entradas menos saídas) tem de **bater ao centavo** com o banco (o que falta do movimento, ou a alocação que já existe) — a tarifa, lança-se como saída e marca-se junto. O movimento ainda livre vem para a tesouraria com a categoria do primeiro lançamento. **Desfazer** apaga a alocação e solta os lançamentos. **Sugestão:** o mesmo `sugerirPares` da Administrativa (mesmo tipo e valor ao centavo, até 3 dias), entre o movimento inteiro ainda livre e o lançamento a conciliar — estado `sugerido` da linha. A conciliação automática pelo código do gateway não existe: o extrato da Pluggy não traz o código da venda.
- **Distribuir:** `POST …/alocacoes` com `partes: [{ movimentoId, valor? }]` — sem valor, o que falta do movimento; com valor, só uma parte (rateio), e o resto continua a distribuir. Nunca passa do que falta (400). Devolver apaga a alocação. A categoria é texto, das listas de Eventos e de Congregações (`CATEGORIAS`, em `tesourarias.ts`), conferida contra o tipo do movimento.
- **Quem:** a equipe da igreja (admin e tesouraria; dev e super admin) vê todas, cria, fecha, reabre e vê os não alocados. O **tesoureiro(a) completo** de um evento (`@AceitaTesoureiroDoEvento` + recorte no service) vê e mexe só na tesouraria desse evento — lista, conciliação, lançamentos, distribuir, conciliar — e não fecha (403). Fechada, nada mais muda (400) até reabrir. Módulo do plano: Tesouraria.

| Rota (`/churches/:churchId/tesouraria`) | O que faz |
| --- | --- |
| `GET tesourarias?tipo=EVENT\|CONGREGATION` | As tesourarias, com entradas, saídas, resultado e fechamento |
| `POST tesourarias` | `{ kind, eventId? \| name, date?, location? }` |
| `GET tesourarias/nao-alocados?tipo=` | O que a conta ainda não distribuiu, com os bancos e se a conta é própria |
| `GET tesourarias/:id` | A tesouraria, a conta, os bancos, `podeFechar` |
| `POST` / `DELETE tesourarias/:id/fechamento` | Fecha / reabre |
| `GET tesourarias/:id/conciliacao` | As linhas do diff (sugerido, só no banco, só no evento, não consta, conciliado) e `aConciliar` |
| `GET tesourarias/:id/lancamentos` | Os do sistema e o que veio do banco sem par |
| `POST tesourarias/:id/lancamentos` | Lançamento manual do evento (a congregação não tem) |
| `POST tesourarias/:id/alocacoes` | Distribuir (inteiro ou rateio) |
| `PATCH` / `DELETE tesourarias/:id/alocacoes/:alocacaoId` | Categoria / devolver |
| `POST tesourarias/:id/conciliacao` | `{ movimentoId, lancamentoIds }` |
| `DELETE tesourarias/:id/conciliacao/:movimentoId` | Desfaz |
| `POST tesourarias/:id/nao-consta` | `{ lancamentoIds, naoConsta }` |

## Auditoria

`FinancialEntry` passa pelo log de auditoria como as outras tabelas, com o rótulo "Lançamento da tesouraria" (`MODEL_LABELS`), e é tabela principal (`MAIN_MODELS`); o valor do dízimo aparece nas alterações de "Cadastro". O rótulo "Dizimista" (`Tither`) ficou só para as linhas antigas do log. A importação grava um `createMany` só.

## Migration

`20261012170000_tesourarias`: os enums `TreasuryAccount` e `TreasuryKind`; `splitByTreasury` e `itemAccounts` na Pluggy (sem divisão por padrão); `account` (padrão `ADMINISTRATIVE`) e `bankItemId` em `financial_entries`; e as tabelas `treasuries`, `treasury_allocations`, `treasury_entries` e `treasury_payment_links`. Nada existente muda de valor: o que já foi importado nasce da Administrativa. Testada aplicando todas as migrations num Postgres vazio e rodando o fluxo inteiro contra ele (criar, distribuir e ratear, conciliar e desfazer, sugestão, não consta, fechar, tesoureiro completo, a Administrativa sem o distribuído, a conta de Eventos com a divisão).

`20261011190000_conciliacao`: só adiciona as três colunas de conciliação em `financial_entries` (nulas), o índice único e a chave estrangeira; nada existente muda.

`20261012160000_nao_consta_no_banco`: só adiciona `notInBankAt` e `notInBankById` (nulas) em `financial_entries`. Não marca nada: os manuais antigos sem par continuam na fila, e a tesouraria marca os que são dinheiro em espécie. **Não foi aplicada em banco nenhum.**

`20261011150000_financeiro`: só cria as duas tabelas, os enums e os índices; não mexe em nada existente. `20261011160000_valor_do_dizimo`: só adiciona a coluna `expectedAmount` (nula) em `tithers`. `20261011180000_dizimista_e_membro`: a lista de dizimistas vira os membros — cria `users.titheAmount`, **copia** para ele o `expectedAmount` de quem era dizimista na mesma igreja de que é membro, e só então apaga `tithers` (testado: o valor do dizimista da própria igreja seguiu; o de outra igreja, não). Testada aplicando todas as migrations num Postgres vazio e rodando os serviços contra ele (somas em `Decimal`, importação repetida sem duplicar, recorte por igreja).

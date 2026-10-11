# Financeiro (dizimistas, livro-caixa e Pluggy)

Módulo financeiro de cada igreja: quem dizima nela (**dizimistas**) e o livro-caixa (**lançamentos**), com entradas e saídas lançadas à mão e importadas do extrato dos bancos pela Pluggy.

Código: `src/financeiro` (controller, `DizimistasService`, `LancamentosService`, `categorias.ts`) e `src/pluggy/pluggy.service.ts` (leitura do extrato).

## Quem acessa

- `@Roles(...ADMIN_AREA_ROLES)` + `ChurchTenantGuard`, como a Pluggy: dev, super admin, e admin ou financeiro **da igreja da rota**. O financeiro de uma igreja não lê o caixa da outra trocando o `:churchId`.
- Além do guard, todo acesso a um registro é pela igreja da rota junto: um lançamento de outra igreja, ou uma pessoa que não é membro desta, responde 404 e não altera nada.
- Ligar um lançamento a um dizimista exige que a pessoa seja **membro** desta igreja (400 caso contrário).

## Rotas (`/churches/:churchId/financeiro`)

| Rota | O que faz |
| --- | --- |
| `GET dizimistas?ano=` | Todos os membros da igreja, com os números do ano (padrão: o atual) |
| `PATCH dizimistas/:userId` | `{ titheAmount }`: o valor do dízimo do membro (`null` tira) |
| `GET lancamentos?de&ate&type&category&source&busca` | Lançamentos do período, com resumo |
| `POST lancamentos` | Lançamento manual |
| `PATCH lancamentos/:id` | Edita (no importado, só categoria, descrição e dizimista) |
| `DELETE lancamentos/:id` | Apaga o manual; o importado não |
| `POST lancamentos/importar` | Importa o extrato da Pluggy |

## Dizimistas são os membros

- **Não há cadastro de dizimista:** todo membro da igreja (`User.memberChurchId`, ver `docs/membros.md`) é um dizimista em potencial. A lista de dizimistas é a lista de membros; quem entra e sai é o admin, em Membros. O financeiro não adiciona nem tira ninguém.
- **Valor do dízimo** (`User.titheAmount`, `Decimal(12,2)`, opcional): o dízimo combinado com o membro, na igreja de que ele é membro (uma só). É o que a importação usa, junto com o CPF, para separar dízimo de oferta (ver abaixo). `PATCH dizimistas/:userId` define; `null` tira. Só vale para membro desta igreja (404 caso contrário). Deixar de ser membro zera o valor.
- **Números do ano** (`listar`): saem dos lançamentos `INCOME` de categoria `TITHE` desta igreja ligados à pessoa, manuais ou importados. Por membro: total no ano, meses do ano com dízimo (1 a 12) e o último dízimo (de qualquer ano). No resumo: membros, quantos dizimaram no mês e no ano, total do mês e do ano.
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
    
    Continua sendo um palpite: quem manda dízimo e oferta juntos num Pix só, ou mudou o valor do dízimo sem atualizar o cadastro, cai em oferta — o financeiro corrige a categoria (e o valor no cadastro).
  - Outro crédito → "outra entrada", sem pessoa.
  - Débito → categoria pela categoria da Pluggy quando há equivalente claro (tarifas → tarifas bancárias; luz, água, telefone, internet → água/luz/internet; aluguel; salários); o resto, "outra saída".
  - Forma: Pix → Pix; TED/DOC/TEF → transferência; boleto → boleto; o resto fica vazio.
  - Data: o dia da transação **em Brasília** (uma transação às 01:30 UTC do dia 4 é do dia 3).
- Credencial recusada ou integração desligada → 400 com a mensagem; falha de rede ou da Pluggy → 502 ("tente de novo em alguns minutos"). Depois de importar, `lastSyncAt` é atualizado (o card da integração mostra "Última leitura há…").
- Por enquanto a importação é **por botão**: não há webhook da Pluggy nem rotina agendada.

## Auditoria

`FinancialEntry` passa pelo log de auditoria como as outras tabelas, com o rótulo "Lançamento financeiro" (`MODEL_LABELS`), e é tabela principal (`MAIN_MODELS`); o valor do dízimo aparece nas alterações de "Cadastro". O rótulo "Dizimista" (`Tither`) ficou só para as linhas antigas do log. A importação grava um `createMany` só.

## Migration

`20261011150000_financeiro`: só cria as duas tabelas, os enums e os índices; não mexe em nada existente. `20261011160000_valor_do_dizimo`: só adiciona a coluna `expectedAmount` (nula) em `tithers`. `20261011180000_dizimista_e_membro`: a lista de dizimistas vira os membros — cria `users.titheAmount`, **copia** para ele o `expectedAmount` de quem era dizimista na mesma igreja de que é membro, e só então apaga `tithers` (testado: o valor do dizimista da própria igreja seguiu; o de outra igreja, não). Testada aplicando todas as migrations num Postgres vazio e rodando os serviços contra ele (somas em `Decimal`, importação repetida sem duplicar, recorte por igreja).

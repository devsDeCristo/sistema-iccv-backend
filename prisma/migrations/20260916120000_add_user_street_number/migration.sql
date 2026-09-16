-- Rua e número do endereço do cadastro. Até aqui o endereço parava em bairro,
-- cidade e estado — o suficiente para saber de onde a pessoa vem, mas não para
-- chegar até ela.
--
-- Nulas, e não `NOT NULL DEFAULT ''`: os cadastros que já existem não têm esse
-- dado e ninguém sabe qual é. Uma string vazia obrigatória diria que o endereço
-- está preenchido quando ele está em branco, e o relatório não teria como
-- separar "sem número" de "nunca perguntamos".
--
-- `number` é texto, não inteiro: endereço sem número é "s/n", e há número com
-- letra ("120-A").
ALTER TABLE "users" ADD COLUMN "street" TEXT;
ALTER TABLE "users" ADD COLUMN "number" TEXT;

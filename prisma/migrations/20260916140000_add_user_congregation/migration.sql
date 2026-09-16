-- Dados da congregação de quem se cadastra: a igreja que frequenta e o nome do
-- pastor.
--
-- `congregation` é texto livre e não chave para `churches`. A tabela de igrejas
-- guarda quem organiza eventos no sistema; quem se inscreve pode vir de
-- qualquer congregação, e amarrar o campo a ela obrigaria a cadastrar uma
-- igreja só para alguém conseguir dizer de onde vem.
--
-- Nulas: são opcionais no formulário, e os cadastros antigos não têm o dado.
ALTER TABLE "users" ADD COLUMN "congregation" TEXT;
ALTER TABLE "users" ADD COLUMN "pastorName" TEXT;

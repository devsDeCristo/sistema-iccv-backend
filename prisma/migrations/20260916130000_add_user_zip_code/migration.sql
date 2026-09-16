-- CEP do cadastro. Entra separado da migração que criou rua e número porque
-- aquela pode já ter sido aplicada: mexer no arquivo de uma migração aplicada
-- quebra o checksum e o `migrate deploy` passa a falhar no boot.
--
-- Nula pelo mesmo motivo das outras colunas de endereço: os cadastros antigos
-- não têm o dado.
--
-- Guarda os 8 dígitos sem hífen, como `cpf` e `cellphone`. A máscara é
-- apresentação, e gravá-la faria a mesma cidade ter duas formas no banco.
ALTER TABLE "users" ADD COLUMN "zipCode" TEXT;

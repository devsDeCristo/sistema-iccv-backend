-- AlterTable
--
-- Nasce nula: nenhuma das igrejas que já existem tem líder vinculado, e o
-- e-mail delas sai sem assinatura até alguém escolher um. Inventar aqui o
-- líder de uma delas assinaria o e-mail de todas com o mesmo nome — que é
-- exatamente o que esta coluna veio desfazer.
ALTER TABLE "churches" ADD COLUMN "spiritualLeaderId" TEXT;

-- AddForeignKey
--
-- SET NULL: apagar a conta do líder não pode levar a igreja junto.
ALTER TABLE "churches" ADD CONSTRAINT "churches_spiritualLeaderId_fkey" FOREIGN KEY ("spiritualLeaderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

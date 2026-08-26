-- AlterTable
-- Default vazio de propósito: todo quarto que já existe continua aberto, sem
-- backfill e sem mudar o comportamento atual.
ALTER TABLE "bedrooms" ADD COLUMN     "groupTags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
-- Marca qual quarto a entrega do crachá alocou sozinha, para o "reverter
-- entrega" saber qual vaga liberar sem mexer em quarto definido à mão.
ALTER TABLE "checkins" ADD COLUMN     "autoBedroomId" TEXT;

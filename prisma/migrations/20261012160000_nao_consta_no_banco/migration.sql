-- Lançamento manual confirmado como "não consta no banco" (dinheiro em
-- espécie): deixa de pedir conciliação. Só colunas novas, nulas.

-- AlterTable
ALTER TABLE "financial_entries" ADD COLUMN     "notInBankAt" TIMESTAMP(3),
ADD COLUMN     "notInBankById" TEXT;

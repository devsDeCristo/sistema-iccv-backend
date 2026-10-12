-- O valor mensal do plano, em reais. Os planos que já existem ficam com 0
-- (gratuito) até o super admin informar o valor.

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "price" DECIMAL(10,2) NOT NULL DEFAULT 0;

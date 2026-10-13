-- A cobrança online volta a poder ser desligada por igreja, dentro do módulo
-- Eventos do plano. Padrão ligado: nenhuma igreja que cobra hoje deixa de
-- cobrar com a migração.
-- AlterTable
ALTER TABLE "churches" ADD COLUMN "modulePayment" BOOLEAN NOT NULL DEFAULT true;

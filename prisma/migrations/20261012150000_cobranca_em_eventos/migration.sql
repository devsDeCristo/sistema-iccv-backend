-- A cobrança online deixa de ser um módulo próprio e passa a fazer parte de
-- Eventos: dar às igrejas o suporte a pagamentos é parte do que o módulo de
-- eventos é.
--
-- Efeito nas igrejas: quem tinha Eventos sem Cobrança online passa a cobrar
-- pelo site (se tiver gateway configurado); quem tinha Cobrança online sem
-- Eventos deixa de cobrar (não havia evento para cobrar no painel).

UPDATE "plans"
SET "modules" = array_remove("modules", 'ONLINE_PAYMENTS')
WHERE 'ONLINE_PAYMENTS' = ANY("modules");

-- AlterEnum
BEGIN;
CREATE TYPE "ChurchModule_new" AS ENUM ('EVENTS', 'NEWS', 'TREASURY');
ALTER TABLE "plans" ALTER COLUMN "modules" TYPE "ChurchModule_new"[] USING ("modules"::text::"ChurchModule_new"[]);
ALTER TYPE "ChurchModule" RENAME TO "ChurchModule_old";
ALTER TYPE "ChurchModule_new" RENAME TO "ChurchModule";
DROP TYPE "ChurchModule_old";
COMMIT;

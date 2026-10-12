-- WhatsApp e Integrações deixam de ser módulos do plano: as configurações
-- seguem o módulo a que servem (Disparadores/WhatsApp é de Notícias,
-- Integrações/Pluggy é de Tesouraria, Pagamentos/gateways é de Eventos).
--
-- Os planos que tinham os dois perdem só esses valores. Não viram Notícias ou
-- Tesouraria sozinhos: isso daria a uma igreja um módulo que ninguém escolheu.

UPDATE "plans"
SET "modules" = array_remove(array_remove("modules", 'WHATSAPP'), 'INTEGRATIONS')
WHERE "modules" && ARRAY['WHATSAPP', 'INTEGRATIONS']::"ChurchModule"[];

-- AlterEnum
BEGIN;
CREATE TYPE "ChurchModule_new" AS ENUM ('EVENTS', 'NEWS', 'TREASURY', 'ONLINE_PAYMENTS');
ALTER TABLE "plans" ALTER COLUMN "modules" TYPE "ChurchModule_new"[] USING ("modules"::text::"ChurchModule_new"[]);
ALTER TYPE "ChurchModule" RENAME TO "ChurchModule_old";
ALTER TYPE "ChurchModule_new" RENAME TO "ChurchModule";
DROP TYPE "ChurchModule_old";
COMMIT;

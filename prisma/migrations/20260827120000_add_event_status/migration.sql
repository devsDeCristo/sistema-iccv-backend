-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TEST');

-- AlterTable
ALTER TABLE "events" ADD COLUMN "status" "EventStatus" NOT NULL DEFAULT 'ACTIVE';

-- Migra o booleano antigo: o que estava ativo continua ativo, o resto vira inativo.
-- Nenhum evento nasce em TEST, esse estado só é escolhido a mão no painel.
UPDATE "events" SET "status" = CASE WHEN "isActive" THEN 'ACTIVE'::"EventStatus" ELSE 'INACTIVE'::"EventStatus" END;

-- "isActive" continua no banco de propósito: os eventos já existem e nada é
-- apagado. A coluna deixa de ser lida ou escrita pelo código — quem manda na
-- visibilidade do evento agora é "status".

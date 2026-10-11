-- Todo membro é um dizimista em potencial: a lista de dizimistas deixa de
-- ser um cadastro à parte. O que ela guardava de útil — o valor do dízimo,
-- que separa dízimo de oferta na importação do banco — passa para o membro.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "titheAmount" DECIMAL(12,2);

-- O valor combinado segue com a pessoa, quando ela é membro da mesma igreja
-- em que estava como dizimista (uma pessoa é membro de uma igreja só).
UPDATE "users" u
SET "titheAmount" = t."expectedAmount"
FROM "tithers" t
WHERE t."userId" = u."id"
  AND t."churchId" = u."memberChurchId"
  AND t."expectedAmount" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "tithers" DROP CONSTRAINT "tithers_churchId_fkey";

-- DropForeignKey
ALTER TABLE "tithers" DROP CONSTRAINT "tithers_userId_fkey";

-- DropTable
DROP TABLE "tithers";

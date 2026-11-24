-- O desconto da inscrição deixa de apontar para a tabela `discounts` (global,
-- sem igreja) e passa a ser o percentual direto, de 0 a 100.

-- 1. A coluna nova
ALTER TABLE "EventOnUsersRolesRegistration" ADD COLUMN "discountPercent" DOUBLE PRECISION;

-- 2. Quem já tinha desconto leva o mesmo percentual. A tabela guardava fração
--    (0.1 = 10%); a coluna nova guarda pontos percentuais. Desconto zero vira
--    nulo, que é "sem desconto".
UPDATE "EventOnUsersRolesRegistration" AS r
SET "discountPercent" = ROUND((d."percentage" * 100)::numeric, 2)
FROM "discounts" AS d
WHERE r."discountId" = d."id"
  AND d."percentage" > 0;

-- 3. O vínculo antigo e a tabela saem
ALTER TABLE "EventOnUsersRolesRegistration" DROP CONSTRAINT "EventOnUsersRolesRegistration_discountId_fkey";
DROP INDEX "EventOnUsersRolesRegistration_discountId_idx";
ALTER TABLE "EventOnUsersRolesRegistration" DROP COLUMN "discountId";
DROP TABLE "discounts";

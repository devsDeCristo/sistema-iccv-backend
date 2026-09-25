-- AlterTable
--
-- A foto única vira uma lista de até 5; a primeira é a capa.
ALTER TABLE "event_products" ADD COLUMN "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- A foto que já existe vira a capa da lista antes de a coluna antiga sair:
-- nenhum produto cadastrado perde a foto na migração.
UPDATE "event_products" SET "images" = ARRAY["image"] WHERE "image" IS NOT NULL AND "image" <> '';

ALTER TABLE "event_products" DROP COLUMN "image";

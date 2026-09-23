-- CreateEnum
CREATE TYPE "ChurchStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TEST');

-- AlterTable
--
-- Toda igreja que já existe nasce ACTIVE: é o que ela é hoje. Com qualquer
-- outro padrão, aplicar a migração tiraria todas do filtro da home de uma vez.
ALTER TABLE "churches" ADD COLUMN "status" "ChurchStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'OPPORTUNITY_PROPOSAL';
ALTER TYPE "NotificationType" ADD VALUE 'OPPORTUNITY_PROPOSAL_ANSWERED';

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "proposedById" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "status" "OpportunityStatus" NOT NULL DEFAULT 'PENDING';

-- As vagas que já existem foram publicadas pelo admin: continuam no ar.
-- O padrão PENDING vale só para as linhas novas (a proposta de um membro).
UPDATE "opportunities" SET "status" = 'APPROVED';

-- CreateIndex
CREATE INDEX "opportunities_proposedById_idx" ON "opportunities"("proposedById");

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


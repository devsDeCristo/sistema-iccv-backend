-- AlterEnum
ALTER TYPE "ChurchRequestStatus" ADD VALUE 'AWAITING_TREASURY';
ALTER TYPE "ChurchRequestStatus" ADD VALUE 'AWAITING_PASTOR';

-- AlterTable
ALTER TABLE "church_requests" ADD COLUMN     "pastorAt" TIMESTAMP(3),
ADD COLUMN     "pastorDecision" BOOLEAN,
ADD COLUMN     "pastorId" TEXT,
ADD COLUMN     "treasurerId" TEXT,
ADD COLUMN     "treasuryAt" TIMESTAMP(3),
ADD COLUMN     "treasuryDecision" BOOLEAN;

-- AlterTable
ALTER TABLE "church_request_items" ADD COLUMN     "pastorAccepted" BOOLEAN,
ADD COLUMN     "treasuryAccepted" BOOLEAN;

-- AddForeignKey
ALTER TABLE "church_requests" ADD CONSTRAINT "church_requests_pastorId_fkey" FOREIGN KEY ("pastorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "church_requests" ADD CONSTRAINT "church_requests_treasurerId_fkey" FOREIGN KEY ("treasurerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

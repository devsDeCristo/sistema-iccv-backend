-- CreateEnum
CREATE TYPE "InterestStage" AS ENUM ('NEW', 'REVIEWING', 'INTERVIEW', 'SELECTED', 'DISCARDED');

-- AlterTable
ALTER TABLE "opportunity_interests" ADD COLUMN     "note" TEXT,
ADD COLUMN     "stage" "InterestStage" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "trackedAt" TIMESTAMP(3);


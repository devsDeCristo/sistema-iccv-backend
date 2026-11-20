-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'OPPORTUNITY';

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "closesAt" TIMESTAMP(3),
ADD COLUMN     "data" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "opportunity_interests" ADD COLUMN     "answers" JSONB NOT NULL DEFAULT '{}';


-- CreateEnum
CREATE TYPE "MinorApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "EventOnUsers" ADD COLUMN     "minorApprovalRejectionReason" TEXT,
ADD COLUMN     "minorApprovalReviewedAt" TIMESTAMP(3),
ADD COLUMN     "minorApprovalReviewedById" TEXT,
ADD COLUMN     "minorApprovalStatus" "MinorApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "signedTermUrl" TEXT;

-- AlterTable
ALTER TABLE "events" ALTER COLUMN "churchId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "guardianName" TEXT,
ADD COLUMN     "guardianPhone" TEXT;

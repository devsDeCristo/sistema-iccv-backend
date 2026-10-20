-- AlterTable
ALTER TABLE "EventOnUsers" ADD COLUMN "certificateCode" TEXT;

-- CreateTable
CREATE TABLE "event_certificates" (
    "eventId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "workload" TEXT,
    "signers" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_certificates_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventOnUsers_certificateCode_key" ON "EventOnUsers"("certificateCode");

-- AddForeignKey
ALTER TABLE "event_certificates" ADD CONSTRAINT "event_certificates_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

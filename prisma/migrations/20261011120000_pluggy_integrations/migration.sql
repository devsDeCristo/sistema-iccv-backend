-- CreateTable
CREATE TABLE "pluggy_integrations" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "credentialsHint" JSONB,
    "itemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "statusMessage" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "pluggy_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pluggy_integrations_churchId_key" ON "pluggy_integrations"("churchId");

-- AddForeignKey
ALTER TABLE "pluggy_integrations" ADD CONSTRAINT "pluggy_integrations_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;


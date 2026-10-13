-- Admin de evento: administra um evento sem ser admin da igreja. Só cria a
-- tabela; nada é copiado.
-- CreateTable
CREATE TABLE "event_admins" (
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "event_admins_pkey" PRIMARY KEY ("eventId","userId")
);

-- CreateIndex
CREATE INDEX "event_admins_userId_idx" ON "event_admins"("userId");

-- AddForeignKey
ALTER TABLE "event_admins" ADD CONSTRAINT "event_admins_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_admins" ADD CONSTRAINT "event_admins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

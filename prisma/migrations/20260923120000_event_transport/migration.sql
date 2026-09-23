-- Transporte do evento: mesma estrutura de quarto (capacidade, tags, restrição
-- por grupo de inscrição), porque o problema é o mesmo — encaixar pessoas em
-- lugares que têm limite.

-- CreateTable
CREATE TABLE "transports" (
    "id" TEXT NOT NULL,
    "note" TEXT,
    "eventId" TEXT NOT NULL,
    "capacity" INTEGER,
    "name" TEXT NOT NULL DEFAULT 'Transporte sem nome',
    "tag" TEXT[],
    "groupTags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "transports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transports_on_users" (
    "userId" TEXT NOT NULL,
    "transportId" TEXT NOT NULL,

    CONSTRAINT "transports_on_users_pkey" PRIMARY KEY ("userId","transportId")
);

-- CreateIndex
CREATE INDEX "transports_eventId_idx" ON "transports"("eventId");

-- CreateIndex
CREATE INDEX "transports_on_users_transportId_idx" ON "transports_on_users"("transportId");

-- AddForeignKey
ALTER TABLE "transports" ADD CONSTRAINT "transports_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transports_on_users" ADD CONSTRAINT "transports_on_users_transportId_fkey" FOREIGN KEY ("transportId") REFERENCES "transports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transports_on_users" ADD CONSTRAINT "transports_on_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "churches" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "churches_pkey" PRIMARY KEY ("id")
);

-- Insert default church
INSERT INTO "churches" ("id", "name") VALUES ('default', 'Igreja Padrão');

-- AddColumn to users
ALTER TABLE "users" ADD COLUMN "churchId" TEXT;

-- AddColumn to events (com valor padrão que agora existe)
ALTER TABLE "events" ADD COLUMN "churchId" TEXT NOT NULL DEFAULT 'default';

-- CreateIndex
CREATE INDEX "users_churchId_idx" ON "users"("churchId");
CREATE INDEX "events_churchId_idx" ON "events"("churchId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

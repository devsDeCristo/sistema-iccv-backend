-- Uma solicitação passa a ter vários produtos (nome, quantidade, link) e a
-- situação "aceita parcialmente", com a decisão do admin por produto.

-- AlterEnum
ALTER TYPE "ChurchRequestStatus" ADD VALUE 'PARTIALLY_ACCEPTED';

-- CreateTable
CREATE TABLE "church_request_items" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "link" TEXT,
    "accepted" BOOLEAN,
    "position" INTEGER NOT NULL,

    CONSTRAINT "church_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "church_request_items_requestId_idx" ON "church_request_items"("requestId");

-- AddForeignKey
ALTER TABLE "church_request_items" ADD CONSTRAINT "church_request_items_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "church_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cada solicitação que já existe vira um produto: o título e o link que ela
-- tinha, com a decisão que a situação dela já dizia. Antes de apagar a coluna,
-- senão o link se perde. O id sai do md5 do id da solicitação, no formato de
-- uuid (a API confere os ids dos produtos como uuid), sem depender de
-- extensão de uuid no banco.
INSERT INTO "church_request_items" ("id", "requestId", "name", "quantity", "link", "accepted", "position")
SELECT
    substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-' || substr(h, 13, 4) || '-' ||
        substr(h, 17, 4) || '-' || substr(h, 21, 12),
    "id",
    "title",
    1,
    "link",
    CASE "status"
        WHEN 'ACCEPTED' THEN TRUE
        WHEN 'REJECTED' THEN FALSE
        ELSE NULL
    END,
    0
FROM (SELECT *, md5("id" || ':produto') AS h FROM "church_requests") AS s;

-- AlterTable
ALTER TABLE "church_requests" DROP COLUMN "link";

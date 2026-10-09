-- Grupos de WhatsApp avulsos como destino de notícia: link de convite colado no
-- formulário, de grupo que não é grupo de inscrição de evento.

-- CreateTable
CREATE TABLE "news_group_links" (
    "id" TEXT NOT NULL,
    "newsId" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "news_group_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "news_group_links_newsId_link_key" ON "news_group_links"("newsId", "link");

-- AddForeignKey
ALTER TABLE "news_group_links" ADD CONSTRAINT "news_group_links_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE CASCADE ON UPDATE CASCADE;


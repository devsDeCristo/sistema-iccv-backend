-- A notícia também é de uma igreja: sem a coluna, a lista do painel e os grupos
-- de WhatsApp oferecidos no formulário eram os de todas as igrejas juntas, e um
-- admin conseguia disparar mensagem nos grupos da igreja vizinha.
--
-- Nulo continua valendo como aviso do sistema (publicado pelo super admin, que
-- não pertence a nenhuma igreja) e aparece no feed de todo mundo.
ALTER TABLE "news" ADD COLUMN "churchId" TEXT;

-- Notícia antiga herda a igreja de quem publicou.
UPDATE "news"
SET "churchId" = "users"."churchId"
FROM "users"
WHERE "users"."id" = "news"."authorId"
  AND "news"."churchId" IS NULL;

CREATE INDEX "news_churchId_idx" ON "news"("churchId");

ALTER TABLE "news"
  ADD CONSTRAINT "news_churchId_fkey"
  FOREIGN KEY ("churchId") REFERENCES "churches"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

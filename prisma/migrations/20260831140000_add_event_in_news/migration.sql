-- Público do anúncio.
--
-- Notícia é para todo mundo por padrão — nulo aqui é exatamente isso, e é onde
-- as que já existem ficam. Quando o admin escolhe um evento no formulário, o
-- mural passa a mostrá-la só para quem está nele (inscrito ou na lista de
-- espera).
--
-- Não confundir com `churchId`, que diz quem administra a notícia.
ALTER TABLE "news" ADD COLUMN "eventId" TEXT;

CREATE INDEX "news_eventId_idx" ON "news"("eventId");

-- Cascade e não SetNull: anúncio de um evento que deixou de existir não pode
-- virar aviso geral de repente.
ALTER TABLE "news"
  ADD CONSTRAINT "news_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

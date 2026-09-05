-- Amarra as várias escritas de uma mesma requisição: uma ação do painel toca em
-- três ou quatro tabelas, e sem isto a tela de atividades mostra cada uma como
-- um evento separado.
-- AlterTable
ALTER TABLE "logs" ADD COLUMN     "requestId" TEXT;

-- Backfill das linhas antigas, que nasceram antes do id existir. A aproximação
-- é o que a própria operação sugere: as escritas de uma mesma ação são do mesmo
-- autor e caem no mesmo segundo. Duas ações distintas do mesmo usuário dentro
-- do mesmo segundo acabam juntas — é raro e é o preço de não ter o id de
-- verdade no histórico.
UPDATE "logs"
SET "requestId" = 'legado-' || md5(
  coalesce("userId", 'sistema') || '|' ||
  date_trunc('second', "createdAt")::text
);

-- CreateIndex
CREATE INDEX "logs_requestId_idx" ON "logs"("requestId");

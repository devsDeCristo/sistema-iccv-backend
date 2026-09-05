-- Quem a ação atingiu. É lista porque um `deleteMany` derruba o vínculo de
-- várias pessoas numa tacada só. Sem esta coluna, o filtro por usuário da tela
-- de atividades teria que abrir o JSON de todas as linhas a cada consulta.
-- AlterTable
ALTER TABLE "logs" ADD COLUMN     "targetUserIds" TEXT[];

-- Backfill das linhas já gravadas: o usuário afetado é extraído dos snapshots.
-- Cobre os três formatos que o middleware produz — o próprio cadastro quando o
-- model é `User`, o `userId` de um snapshot único e o de cada item quando a
-- operação foi em lote (createMany/updateMany/deleteMany gravam array).
UPDATE "logs" l
SET "targetUserIds" = sub.ids
FROM (
  SELECT id, array_agg(DISTINCT uid) FILTER (WHERE uid IS NOT NULL) AS ids
  FROM (
    SELECT id, "entityId" AS uid FROM "logs" WHERE model = 'User'
    UNION ALL
    SELECT id, after->>'id' FROM "logs"
      WHERE model = 'User' AND jsonb_typeof(after) = 'object'
    UNION ALL
    SELECT id, before->>'id' FROM "logs"
      WHERE model = 'User' AND jsonb_typeof(before) = 'object'
    UNION ALL
    SELECT id, after->>'userId' FROM "logs" WHERE jsonb_typeof(after) = 'object'
    UNION ALL
    SELECT id, before->>'userId' FROM "logs" WHERE jsonb_typeof(before) = 'object'
    UNION ALL
    SELECT l2.id, elem->>'userId' FROM "logs" l2,
      LATERAL jsonb_array_elements(l2.after) elem
      WHERE jsonb_typeof(l2.after) = 'array'
    UNION ALL
    SELECT l3.id, elem->>'userId' FROM "logs" l3,
      LATERAL jsonb_array_elements(l3.before) elem
      WHERE jsonb_typeof(l3.before) = 'array'
  ) x
  GROUP BY id
) sub
WHERE l.id = sub.id AND sub.ids IS NOT NULL;

-- CreateIndex
CREATE INDEX "logs_createdAt_idx" ON "logs"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "logs_userId_createdAt_idx" ON "logs"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "logs_targetUserIds_idx" ON "logs" USING GIN ("targetUserIds" array_ops);

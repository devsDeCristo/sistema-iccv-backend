-- Reagrupa o histórico que nasceu antes do `requestId` existir.
--
-- O primeiro backfill cortava por segundo cheio, e isso partia ao meio toda
-- ação que atravessasse a virada do segundo — 456 casos aqui. O critério certo
-- é o intervalo entre uma escrita e a seguinte: escritas do mesmo autor
-- separadas por menos de um segundo são a mesma operação, não importa em que
-- segundo caiam.
--
-- Mexe só nas linhas marcadas como legado: as que já tiverem `requestId` de
-- verdade vieram do interceptor e são exatas.
WITH ordenado AS (
  SELECT
    id,
    coalesce("userId", 'sistema') AS autor,
    "createdAt",
    LAG("createdAt") OVER (
      PARTITION BY coalesce("userId", 'sistema')
      ORDER BY "createdAt", id
    ) AS anterior
  FROM "logs"
  WHERE "requestId" LIKE 'legado-%'
),
ilhas AS (
  SELECT
    id,
    autor,
    SUM(
      CASE
        WHEN anterior IS NULL OR "createdAt" - anterior > interval '1 second'
        THEN 1 ELSE 0
      END
    ) OVER (PARTITION BY autor ORDER BY "createdAt", id) AS ilha
  FROM ordenado
)
UPDATE "logs" l
SET "requestId" = 'legado-' || md5(i.autor || '|' || i.ilha::text)
FROM ilhas i
WHERE l.id = i.id;

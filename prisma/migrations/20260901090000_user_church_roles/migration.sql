-- Permissão por igreja.
--
-- Antes a pessoa tinha um perfil (`users.role`) e uma igreja (`users.churchId`),
-- então não dava para ser admin de uma igreja e financeiro de outra. Agora o
-- vínculo é uma linha por igreja, e `users.role` passa a guardar só o perfil
-- efetivo (o mais alto), que é o que os guards de rota leem.
CREATE TABLE "user_church_roles" (
    "userId" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "role" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_church_roles_pkey" PRIMARY KEY ("userId","churchId")
);

CREATE INDEX "user_church_roles_churchId_idx" ON "user_church_roles"("churchId");

ALTER TABLE "user_church_roles"
  ADD CONSTRAINT "user_church_roles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_church_roles"
  ADD CONSTRAINT "user_church_roles_churchId_fkey"
  FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Quem já era admin (2) ou financeiro (3) de uma igreja vira um vínculo dela.
INSERT INTO "user_church_roles" ("userId", "churchId", "role", "createdAt", "updatedAt")
SELECT "id", "churchId", "role", NOW(), NOW()
FROM "users"
WHERE "churchId" IS NOT NULL
  AND "role" IN (2, 3);

-- A coluna sai: manter as duas fontes vivas é como o recorte volta a divergir.
DROP INDEX IF EXISTS "users_churchId_idx";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_churchId_fkey";
ALTER TABLE "users" DROP COLUMN "churchId";

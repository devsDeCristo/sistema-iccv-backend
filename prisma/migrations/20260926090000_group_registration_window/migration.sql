-- Janela de inscrição por grupo. Os grupos existentes seguem ativos e sem data.
ALTER TABLE "group_roles" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "opensAt" TIMESTAMP(3),
ADD COLUMN "closesAt" TIMESTAMP(3);

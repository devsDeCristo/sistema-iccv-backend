-- Registro de tentativas de entrada.
--
-- Até aqui o sistema não guardava nada sobre acesso: nem último login, nem
-- tentativa. O painel conseguia dizer quem alterou um quarto, mas não quem
-- entrou — e muito menos quantas vezes alguém errou a senha na porta.
--
-- A tabela nasce vazia de propósito: não há como reconstruir o histórico de
-- acesso que nunca foi gravado. O gráfico do painel começa a encher a partir
-- do primeiro login depois deste deploy.
CREATE TYPE "LoginFailureReason" AS ENUM ('USER_NOT_FOUND', 'WRONG_PASSWORD');

CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "userId" TEXT,
    "success" BOOLEAN NOT NULL,
    "reason" "LoginFailureReason",
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- O gráfico varre uma janela de dias; o índice por usuário atende "as
-- tentativas desta conta", que é a pergunta seguinte quando as falhas sobem.
CREATE INDEX "login_attempts_createdAt_idx" ON "login_attempts"("createdAt" DESC);
CREATE INDEX "login_attempts_userId_createdAt_idx" ON "login_attempts"("userId", "createdAt" DESC);

-- SetNull e não Cascade: apagar o cadastro de alguém não pode apagar o rastro
-- das tentativas feitas em nome dele.
ALTER TABLE "login_attempts"
  ADD CONSTRAINT "login_attempts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

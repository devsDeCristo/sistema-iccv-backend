-- Uma sessão de WhatsApp por igreja.
--
-- Até aqui a sessão era uma só para o sistema inteiro: um número, uma conexão,
-- compartilhada por todas as igrejas. Quem pareava ou desconectava mexia no
-- aviso de todo mundo, e por isso a tela era do super admin — um admin de
-- igreja derrubaria o disparo das outras. Com o número por igreja, cada uma
-- avisa os próprios inscritos pelo próprio número, e o painel da cobrança e o
-- do disparo passam a ter o mesmo dono.
--
-- O `id` é a chave interna do Baileys (`creds`, `pre-key-3`, `session-5511…`) e
-- só é única dentro de uma sessão. Sem o `churchId` na chave primária, a
-- credencial de uma igreja sobrescreveria a da outra já na primeira gravação.

-- A sessão atual é descartada: o material do Signal é do par número/aparelho e
-- não há a quem atribuí-lo sem escolher uma igreja no lugar de quem decide.
-- Cada igreja pareia o seu número na tela de Disparadores; até lá, nenhuma
-- notícia sai por WhatsApp.
DELETE FROM "whatsapp_auth";

ALTER TABLE "whatsapp_auth" DROP CONSTRAINT "whatsapp_auth_pkey";

ALTER TABLE "whatsapp_auth" ADD COLUMN "churchId" TEXT NOT NULL;

ALTER TABLE "whatsapp_auth"
  ADD CONSTRAINT "whatsapp_auth_pkey" PRIMARY KEY ("churchId", "id");

CREATE INDEX "whatsapp_auth_churchId_idx" ON "whatsapp_auth"("churchId");

-- Cascade: a sessão não existe fora da igreja. Apagada a igreja, o material
-- criptográfico dela não serve a ninguém e não pode ficar para trás.
ALTER TABLE "whatsapp_auth"
  ADD CONSTRAINT "whatsapp_auth_churchId_fkey"
  FOREIGN KEY ("churchId") REFERENCES "churches"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

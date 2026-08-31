-- `users.churchId` é o vínculo de quem entra no painel: admin (2) e financeiro
-- (3). Usuário comum não pertence a igreja nenhuma — ele se inscreve em evento
-- de qualquer uma, e é a inscrição que o mostra para aquele painel.
--
-- A migration anterior criou a igreja 'default' e jogou os eventos nela, mas
-- deixou `users.churchId` nulo em todo mundo. Com o recorte falhando fechado
-- (admin sem igreja não acessa nada), os administradores atuais ficariam de
-- fora do painel — e, enquanto a checagem falhava aberta, enxergavam todas as
-- igrejas. Aqui eles entram na igreja padrão, que é onde sempre estiveram.
UPDATE "users"
SET "churchId" = 'default'
WHERE "churchId" IS NULL
  AND "role" IN (2, 3)
  AND EXISTS (SELECT 1 FROM "churches" WHERE "id" = 'default');

-- Fora do painel o campo não tem uso: se alguém foi vinculado antes desta
-- regra existir, o vínculo sai agora.
UPDATE "users"
SET "churchId" = NULL
WHERE "churchId" IS NOT NULL
  AND "role" NOT IN (2, 3);

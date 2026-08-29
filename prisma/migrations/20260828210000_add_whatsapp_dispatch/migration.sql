-- CreateTable
CREATE TABLE "news_on_group_roles" (
    "newsId" TEXT NOT NULL,
    "groupRoleId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "news_on_group_roles_pkey" PRIMARY KEY ("newsId","groupRoleId")
);

-- CreateIndex
CREATE INDEX "news_on_group_roles_groupRoleId_idx" ON "news_on_group_roles"("groupRoleId");

-- AddForeignKey
ALTER TABLE "news_on_group_roles" ADD CONSTRAINT "news_on_group_roles_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_on_group_roles" ADD CONSTRAINT "news_on_group_roles_groupRoleId_fkey" FOREIGN KEY ("groupRoleId") REFERENCES "group_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "whatsapp_auth" (
    "id" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_auth_pkey" PRIMARY KEY ("id")
);

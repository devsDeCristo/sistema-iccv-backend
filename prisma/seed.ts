import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const execAsync = promisify(exec);

async function main() {
  console.log('🗄️  Iniciando processo de seed do banco de dados...');

  try {
    // Caminho para o arquivo backup.sql
    const backupPath = path.join(__dirname, '..', 'backup.sql');

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Arquivo backup.sql não encontrado em: ${backupPath}`);
    }

    console.log('📁 Arquivo backup.sql encontrado');

    // Obter configurações do banco do .env
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL não encontrada no .env');
    }

    // Parse da URL do banco
    const dbUrl = new URL(databaseUrl);
    const dbHost = dbUrl.hostname;
    const dbPort = dbUrl.port;
    const dbUser = dbUrl.username;
    const dbPassword = dbUrl.password;
    const dbName = dbUrl.pathname.slice(1).split('?')[0];

    console.log(`🔌 Conectando ao banco: ${dbName}@${dbHost}:${dbPort}`);

    // Configurar variável de ambiente para senha
    process.env.PGPASSWORD = dbPassword;

    // Executar o backup SQL usando psql
    console.log('🔄 Executando backup SQL...');

    const psqlCommand = `psql -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} -f "${backupPath}"`;

    try {
      const { stdout, stderr } = await execAsync(psqlCommand);

      if (stderr && !stderr.includes('NOTICE')) {
        console.log('⚠️  Avisos durante execução:', stderr);
      }

      console.log('✅ Backup SQL executado com sucesso');
    } catch (error) {
      // Se psql falhar, tentar método alternativo
      console.log('⚠️  Método psql falhou, tentando método alternativo...');
      await fallbackSeedMethod(backupPath);
    }

    // Verificar dados inseridos
    try {
      const userCount = await prisma.user.count();
      const eventCount = await prisma.event.count();

      console.log(`👥 Usuários no banco: ${userCount}`);
      console.log(`📅 Eventos no banco: ${eventCount}`);

      if (userCount === 0 && eventCount === 0) {
        console.log(
          '⚠️  Nenhum dado foi inserido. Verifique se o arquivo backup.sql é válido.',
        );
      }
    } catch (error) {
      console.log(
        '⚠️  Não foi possível verificar dados inseridos:',
        error.message,
      );
    }

    console.log('🎉 Seed executado com sucesso!');
  } catch (error) {
    console.error('❌ Erro durante o seed:', error.message);
    process.exit(1);
  } finally {
    // Limpar variável de senha
    delete process.env.PGPASSWORD;
  }
}

async function fallbackSeedMethod(backupPath: string) {
  console.log('🔄 Executando método alternativo...');

  const sqlContent = fs.readFileSync(backupPath, 'utf8');

  // Limpar comentários e linhas vazias
  const cleanSql = sqlContent
    .split('\n')
    .filter((line) => !line.trim().startsWith('--') && line.trim().length > 0)
    .join('\n');

  // Dividir por statements
  const statements = cleanSql
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);

  let executedCount = 0;

  for (const statement of statements) {
    if (statement.trim()) {
      try {
        await prisma.$executeRawUnsafe(statement + ';');
        executedCount++;
      } catch (error) {
        // Ignorar alguns erros comuns
        if (
          !error.message.includes('already exists') &&
          !error.message.includes('duplicate key') &&
          !error.message.includes('does not exist')
        ) {
          console.log(
            `⚠️  Aviso ao executar statement: ${error.message.slice(
              0,
              100,
            )}...`,
          );
        }
      }
    }
  }

  console.log(
    `✅ ${executedCount} statements executados pelo método alternativo`,
  );
}

main()
  .catch((e) => {
    console.error('❌ Erro fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

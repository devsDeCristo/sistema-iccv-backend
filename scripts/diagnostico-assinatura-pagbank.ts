/**
 * Por que o `x-authenticity-token` do PagBank não está batendo.
 *
 * Pega a última notificação guardada pelo inspetor do ngrok (o corpo byte a
 * byte e o cabeçalho que veio), abre o token cadastrado da igreja e testa as
 * composições possíveis do hash. Diz qual delas confere — ou que nenhuma
 * confere, que é a resposta "a casa assinou com outro token".
 *
 * Não imprime o token nem o hash inteiro: só o nome da variante, o tamanho do
 * corpo e os primeiros caracteres de cada assinatura.
 *
 * Uso, na raiz do projeto, com o backend e o ngrok rodando e uma notificação
 * recém-recebida:
 *
 *   npx ts-node -T scripts/diagnostico-assinatura-pagbank.ts
 *
 * Para testar um token candidato (o "token da conta" do iBanking, por exemplo)
 * sem gravá-lo em lugar nenhum:
 *
 *   PAGBANK_TOKEN_CANDIDATO=... npx ts-node -T scripts/diagnostico-assinatura-pagbank.ts
 *
 * Fora daqui não serve: em produção não há ngrok guardando a requisição. Lá
 * quem responde é o WARN do `PagbankGateway`, que já imprime o tamanho do
 * corpo, o tamanho do token e o prefixo dos dois hashes.
 */
/**
 * Primeiro de todos: o `src/...` dos imports do projeto é resolvido pelo
 * `baseUrl` do tsconfig, que o ts-node sozinho não conhece. Sem esta linha o
 * script morre em "Cannot find module 'src/prisma/prisma.service'" ao carregar
 * o registry.
 */
import 'tsconfig-paths/register';
import 'dotenv/config';
import { createHash, createHmac } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import { contextoDoSelo } from '../src/gateways/core/payment-gateway.registry';

const sha = (texto: string) =>
  createHash('sha256').update(texto, 'utf8').digest('hex');

/** `fetch` do Node 18+; o `lib` do tsconfig não o declara, daí o cast */
const buscar = (globalThis as any).fetch as (
  url: string,
) => Promise<{ json: () => Promise<any> }>;

function variantes(token: string, corpo: string): Record<string, string> {
  return {
    'token-corpo (o que o sistema usa)': sha(`${token}-${corpo}`),
    'tokencorpo (sem o hífen)': sha(`${token}${corpo}`),
    'corpo-token (invertido)': sha(`${corpo}-${token}`),
    'token-corpo, corpo sem espaços nas pontas': sha(
      `${token}-${corpo.trim()}`,
    ),
    'hmac-sha256(chave=token, corpo)': createHmac('sha256', token)
      .update(corpo, 'utf8')
      .digest('hex'),
    'sha256 só do corpo': sha(corpo),
  };
}

async function main() {
  const captura = await buscar(
    'http://127.0.0.1:4040/api/requests/http?limit=1',
  ).then((r) => r.json());

  const requisicao = captura?.requests?.[0]?.request;

  if (!requisicao) {
    throw new Error(
      'O inspetor do ngrok não tem nenhuma requisição guardada — refaça o pagamento antes de rodar isto.',
    );
  }

  const bruto = Object.entries(requisicao.headers ?? {}).find(
    ([nome]) => nome.toLowerCase() === 'x-authenticity-token',
  )?.[1] as string[] | string | undefined;

  const recebida = (
    Array.isArray(bruto) ? bruto[0] : bruto ?? ''
  ).toLowerCase();

  // o `raw` do ngrok é a requisição HTTP inteira; o corpo começa depois da
  // linha em branco que separa os cabeçalhos
  const inteira = Buffer.from(requisicao.raw, 'base64').toString('utf8');
  const corpo = inteira.split('\r\n\r\n').slice(1).join('\r\n\r\n');

  const prisma = new PrismaClient();
  const config = await prisma.paymentProviderConfig.findFirstOrThrow({
    where: { provider: 'PAGBANK' },
  });

  const cofre = new SecretCryptoService().decifrar<Record<string, string>>(
    config.credentials as string,
    contextoDoSelo(config.churchId, config.provider),
  );

  const tokens: Record<string, string> = {
    'token cadastrado': (cofre['token'] ?? '').trim(),
  };

  const candidato = (process.env.PAGBANK_TOKEN_CANDIDATO ?? '').trim();
  if (candidato) tokens['token candidato (do ambiente)'] = candidato;

  console.log(`corpo: ${Buffer.byteLength(corpo)} bytes`);
  console.log(`assinatura recebida: ${recebida.slice(0, 10)}…`);

  let achou = false;

  for (const [nomeDoToken, token] of Object.entries(tokens)) {
    console.log(`\n${nomeDoToken} (${token.length} caracteres):`);

    for (const [nome, hash] of Object.entries(variantes(token, corpo))) {
      const confere = hash === recebida;
      achou = achou || confere;
      console.log(`  ${confere ? '✓' : ' '} ${nome}: ${hash.slice(0, 10)}…`);
    }
  }

  console.log(
    achou
      ? '\nUma variante conferiu: o defeito é a fórmula (ou o token) usada no verifyWebhook.'
      : '\nNenhuma variante conferiu: o PagBank assinou com um token que não é este.\n' +
          'Procure no painel, em Vendas online › Integrações, se a conta tem um token de\n' +
          'autenticidade separado do token da API — e rode de novo com\n' +
          'PAGBANK_TOKEN_CANDIDATO=<esse token>.',
  );

  await prisma.$disconnect();
}

main().catch((erro) => {
  console.error('falhou:', erro.message);
  process.exit(1);
});

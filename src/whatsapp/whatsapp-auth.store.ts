import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from 'baileys';
import { PrismaService } from 'src/prisma';

/**
 * Estado de autenticação do Baileys guardado no Postgres.
 *
 * O equivalente pronto da biblioteca (`useMultiFileAuthState`) grava em disco,
 * o que não serve aqui: o container é recriado a cada deploy e a sessão iria
 * junto — alguém teria que parear o número de novo toda vez que subisse uma
 * versão.
 *
 * O formato é o mesmo que a biblioteca usa em arquivo: JSON serializado com o
 * `BufferJSON`, que é quem sabe transformar Buffer e Uint8Array em texto e
 * trazer de volta.
 */

const CHAVE_CREDENCIAIS = 'creds';

/** Chave de uma entrada do Signal: `pre-key-3`, `session-5511...`, etc. */
const chaveDe = (tipo: string, id: string) => `${tipo}-${id}`;

export interface WhatsappAuthState {
  state: AuthenticationState;
  /** Grava as credenciais; o Baileys chama a cada `creds.update`. */
  saveCreds: () => Promise<void>;
}

export async function useDatabaseAuthState(
  prisma: PrismaService,
): Promise<WhatsappAuthState> {
  const ler = async (id: string) => {
    const linha = await prisma.whatsappAuth.findUnique({ where: { id } });

    return linha ? JSON.parse(linha.data, BufferJSON.reviver) : null;
  };

  const gravar = async (id: string, valor: unknown) => {
    const data = JSON.stringify(valor, BufferJSON.replacer);

    await prisma.whatsappAuth.upsert({
      where: { id },
      create: { id, data },
      update: { data },
    });
  };

  const apagar = async (id: string) => {
    await prisma.whatsappAuth.deleteMany({ where: { id } });
  };

  const creds: AuthenticationCreds =
    (await ler(CHAVE_CREDENCIAIS)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const encontrados: { [id: string]: any } = {};

          for (const id of ids) {
            let valor = await ler(chaveDe(tipo, id));

            // A biblioteca espera este tipo já desempacotado; os outros ela
            // consome como vieram.
            if (tipo === 'app-state-sync-key' && valor) {
              valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            }

            if (valor) encontrados[id] = valor;
          }

          return encontrados as {
            [id: string]: SignalDataTypeMap[typeof tipo];
          };
        },

        set: async (dados) => {
          // Uma escrita por chave, em sequência. Em registro novo isso chega a
          // ~100 pre-keys de uma vez, e é a única hora em que o volume importa;
          // no dia a dia são poucas por mensagem.
          for (const tipo in dados) {
            for (const id in dados[tipo]) {
              const valor = dados[tipo][id];
              const chave = chaveDe(tipo, id);

              if (valor) {
                await gravar(chave, valor);
              } else {
                await apagar(chave);
              }
            }
          }
        },
      },
    },

    saveCreds: () => gravar(CHAVE_CREDENCIAIS, creds),
  };
}

/** Apaga a sessão inteira — usado quando o número é desconectado. */
export async function clearDatabaseAuthState(prisma: PrismaService) {
  await prisma.whatsappAuth.deleteMany({});
}

/**
 * Existe número pareado? É o que decide se o sistema reconecta sozinho ao subir.
 *
 * Não basta a linha existir: o Baileys grava credenciais assim que o QR é
 * gerado, e um pareamento abandonado no meio deixa esse rascunho para trás.
 * Subir com ele faria a API gerar QR atrás de ninguém, num laço sem fim — o que
 * vale é o `registered`, marcado só quando o celular confirma.
 */
export async function hasStoredCredentials(prisma: PrismaService) {
  const linha = await prisma.whatsappAuth.findUnique({
    where: { id: CHAVE_CREDENCIAIS },
  });

  if (!linha) return false;

  const creds: AuthenticationCreds = JSON.parse(linha.data, BufferJSON.reviver);

  return !!creds?.registered;
}

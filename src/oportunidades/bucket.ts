import * as admin from 'firebase-admin';

/**
 * Arquivos privados no bucket (o currículo): sem URL pública — quem lê é a
 * API, depois de conferir quem pede. Diferente de `uploadImageFirebase`, que
 * devolve um link aberto e serve para imagem.
 */
export async function salvarNoBucket(
  caminho: string,
  conteudo: Buffer,
  contentType: string,
) {
  await admin
    .storage()
    .bucket()
    .file(caminho)
    .save(conteudo, {
      contentType,
      metadata: { contentType, cacheControl: 'private, max-age=0' },
    });
}

export async function baixarDoBucket(caminho: string) {
  const [conteudo] = await admin.storage().bucket().file(caminho).download();
  return conteudo;
}

/** Apaga o que existir; arquivo que já não está lá não é erro */
export async function apagarDoBucket(caminhos: string[]) {
  const bucket = admin.storage().bucket();
  await Promise.all(
    caminhos.map((c) => bucket.file(c).delete({ ignoreNotFound: true })),
  );
}

import * as admin from 'firebase-admin';

type UploadImageResponse = {
  url: string;
  path: string;
};

/**
 * Sem `cacheControl` explícito o Storage responde `private, max-age=0`, ou seja,
 * o navegador rebaixa a mesma imagem a cada renderização (pesado nas listas de
 * avatares). Como a URL devolvida carrega um `v` novo a cada upload, o arquivo
 * pode ser tratado como imutável sem risco de servir versão antiga.
 */
const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export async function uploadImageFirebase(
  file: Express.Multer.File,
  path: string,
): Promise<UploadImageResponse> {
  const bucket = admin.storage().bucket();
  const bucketName = bucket.name;

  const fileRef = bucket.file(path);

  await fileRef.save(file.buffer, {
    contentType: file.mimetype,
    metadata: {
      contentType: file.mimetype,
      cacheControl: IMAGE_CACHE_CONTROL,
    },
  });

  // o caminho no bucket é fixo (é sobrescrito a cada upload): o `v` faz a URL
  // mudar quando a imagem muda, invalidando o cache do navegador
  const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
    path,
  )}?alt=media&v=${Date.now()}`;

  return {
    url: publicUrl,
    path,
  };
}

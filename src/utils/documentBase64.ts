/**
 * Data URI do arquivo (`data:<mime>;base64,<...>`), para guardar o termo de
 * autorização direto no banco em vez de subir para o Storage — são poucos
 * arquivos por evento/inscrição, e assim abrir o termo depois não depende de
 * uma URL externa. Funciona direto como `href`/`src` no navegador, sem
 * decodificar nada no front.
 */
export function fileToDataUri(file: Express.Multer.File): string {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

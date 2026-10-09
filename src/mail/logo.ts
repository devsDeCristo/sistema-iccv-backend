import * as path from 'path';

/**
 * O logo dos e-mails, anexado inline (`cid:logo`) — os modelos o referenciam
 * no cabeçalho. Num lugar só para os avisos de conta usarem o mesmo arquivo.
 */
export const LOGO_DO_EMAIL = [
  {
    filename: 'logo.png',
    path: path.join(
      process.cwd(),
      'src',
      'mail',
      'templates',
      'assets',
      'logo-branca.png',
    ),
    cid: 'logo',
  },
];

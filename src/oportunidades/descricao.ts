// o pacote é CommonJS (`module.exports`) e o projeto não liga esModuleInterop
import sanitizeHtml = require('sanitize-html');

/**
 * A descrição da vaga é HTML do editor (Quill). Com as propostas, qualquer
 * membro escreve HTML que outros membros, o admin e o app mobile leem: aqui
 * fica só a formatação do editor, numa lista fechada, e o resto sai — script,
 * evento (`onerror`), `style` livre, iframe, imagem, link `javascript:`.
 *
 * Imagem e vídeo saem de propósito: o editor embute a imagem em base64 (pesa
 * no banco) e o vídeo é iframe de fora.
 */
const OPCOES: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'sub',
    'sup',
    'h1',
    'h2',
    'h3',
    'blockquote',
    'pre',
    'ol',
    'ul',
    'li',
    'a',
    'span',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    '*': ['class', 'style'],
  },
  // as classes do Quill: fonte, tamanho, alinhamento, recuo, direção
  allowedClasses: { '*': ['ql-*'] },
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
      'text-align': [/^(left|right|center|justify)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  // link sempre em aba nova e sem dar ao site de fora acesso a esta janela
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer',
    }),
  },
};

export const limparDescricao = (html: string) =>
  sanitizeHtml(html, OPCOES).trim();

/** Sobrou texto depois da limpeza? (`<p><br></p>` do editor vazio não conta) */
export const temTexto = (html: string) =>
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim().length >
  0;

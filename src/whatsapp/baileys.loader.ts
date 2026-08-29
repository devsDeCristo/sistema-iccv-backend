/**
 * Carrega o Baileys sob demanda.
 *
 * A partir da 6.7.x a biblioteca é ESM pura (`"type": "module"`, sem build
 * CommonJS) e o Nest compila para CommonJS — o `require` gerado a partir de um
 * `import` normal estoura com `ERR_REQUIRE_ESM` no Node 20.
 *
 * `import()` resolveria, mas o TypeScript com `module: commonjs` também
 * transpila `import()` para `require()`, e o erro volta igual. O `new Function`
 * monta a chamada em tempo de execução, fora do alcance do compilador, e é o
 * `import()` nativo do Node que roda — o único que sabe carregar ESM daqui.
 *
 * Só os símbolos usados como valor precisam passar por aqui; `import type`
 * continua direto do pacote, porque tipo não sobrevive à compilação.
 */

type ModuloBaileys = typeof import('baileys');

const importaEmTempoDeExecucao = new Function(
  'especificador',
  'return import(especificador)',
) as (especificador: string) => Promise<ModuloBaileys>;

/** Uma carga por processo: as chamadas seguintes reaproveitam esta promessa. */
let modulo: Promise<ModuloBaileys> | null = null;

export function loadBaileys(): Promise<ModuloBaileys> {
  modulo ??= importaEmTempoDeExecucao('baileys');

  return modulo;
}

/**
 * A raiz dos dados do protótipo (prototipo/data).
 *
 * No processo local resolve-se pelo próprio ficheiro; nas funções serverless
 * o caminho compilado muda, por isso experimentam-se candidatos — e a variável
 * DADOS_RAIZ força um caminho à mão quando o alojamento o precisar.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const chave = '__raizPrototipo' as const;

export function raizPrototipo(): string {
  const memo = (globalThis as Record<string, unknown>)[chave];
  if (typeof memo === 'string') return memo;

  const candidatos = [
    process.env.DADOS_RAIZ ?? null,
    resolve(import.meta.dirname, '../../../../../'), // src/nucleo → prototipo (processo local)
    resolve(process.cwd(), 'prototipo'), // funções serverless (cwd = raiz do deploy)
    process.cwd(),
  ].filter((c): c is string => Boolean(c));

  for (const c of candidatos) {
    if (existsSync(join(c, 'data', 'conhecimento'))) {
      (globalThis as Record<string, unknown>)[chave] = c;
      return c;
    }
  }
  const fallback = resolve(import.meta.dirname, '../../../../../');
  (globalThis as Record<string, unknown>)[chave] = fallback;
  return fallback;
}

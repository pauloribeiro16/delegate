/**
 * Saúde da implantação alojada (Vercel).
 *   GET /api/saude — diz se o kernel arranca e se os dados estão no sítio.
 */
import { kernel, json, preflight } from './_kernel.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  const { raizPrototipo } = await import('../prototipo/apps/api/src/nucleo/dados-raiz.ts');
  const raiz = raizPrototipo();
  const dados = {
    conhecimento: existsSync(join(raiz, 'data', 'conhecimento', 'indice.json')),
    registo: existsSync(join(raiz, 'registo')),
    cenarios: existsSync(join(raiz, 'data', 'cenarios_simulados')),
  };
  try {
    const k = await kernel();
    return json({
      ok: true,
      servico: 'delegate-nucleo',
      modo: 'alojado',
      raizDados: raiz,
      dados,
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    });
  } catch (err: any) {
    return json({ ok: false, modo: 'alojado', raizDados: raiz, dados, erro: err?.message ?? String(err) }, 500);
  }
}

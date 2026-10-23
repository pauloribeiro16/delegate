/**
 * Fluxo de eventos por polling (Vercel). O SSE long-lived não é fiável num
 * runtime serverless — as páginas alojadas perguntam aqui de 1,5 em 1,5 s:
 *   GET /api/eventos?desde=N&pessoa=pseudónimo
 * Devolve os eventos a partir de `desde`, no mesmo formato do SSE.
 */
import { kernel, json, preflight } from './_kernel.ts';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ erro: 'só GET' }, 405);
  try {
    const k = await kernel();
    await k.despacharNotificacoesSU();
    const pergunta = new URL(req.url).searchParams;
    const cru = Number(pergunta.get('desde') ?? '0');
    const desde = Number.isSafeInteger(cru) && cru >= 0 ? cru : 0;
    const pessoa = pergunta.get('pessoa') ?? undefined;
    const eventos = await k.registro.desde(desde, 500, undefined);
    const filtrados = pessoa ? eventos.filter((e: any) => e.pessoa === pessoa) : eventos;
    return json({ eventos: filtrados });
  } catch (err: any) {
    return json({ erro: err?.message ?? String(err) }, 500);
  }
}

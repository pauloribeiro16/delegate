/**
 * Pedidos do dia para a Consola Municipal (Vercel).
 *   GET /api/consola/pedidos
 * Aproveita o pedido para despachar notificações do SU ao cidadão
 * (sem LISTEN num runtime serverless, quem serve faz o despacho).
 */
import { kernel, json, preflight } from '../_kernel.ts';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ erro: 'só GET' }, 405);
  try {
    const k = await kernel();
    await k.despacharNotificacoesSU();
    return json(await k.obterPedidosConsola());
  } catch (err: any) {
    return json({ erro: err?.message ?? String(err) }, 500);
  }
}

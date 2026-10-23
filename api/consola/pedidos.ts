/**
 * Pedidos do dia para a Consola Municipal (Vercel).
 *   GET /api/consola/pedidos
 * Aproveita o pedido para despachar notificações do SU ao cidadão
 * (sem LISTEN num runtime serverless, quem serve faz o despacho).
 */
import { kernel, json, preflight } from '../_kernel.js';

export const config = { maxDuration: 30 };

export async function GET(req: Request): Promise<Response> {
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

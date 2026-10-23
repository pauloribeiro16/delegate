/**
 * Confirmação da Chave Móvel Digital (Vercel).
 *   POST /api/cmd/confirmar  { token_cmd, ... }
 */
import { kernel, json, corpoJson, preflight } from '../_kernel.js';

export const config = { maxDuration: 30 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ ok: false, erro: 'só POST' }, 405);
  try {
    const dados = await corpoJson<{ token_cmd?: string }>(req);
    if (!dados?.token_cmd || typeof dados.token_cmd !== 'string' || dados.token_cmd.trim().length === 0) {
      return json({ ok: false, erro: 'Token CMD inválido ou ausente' }, 400);
    }
    const k = await kernel();
    await k.confirmarCmd(dados as never);
    return json({ ok: true, token: dados.token_cmd });
  } catch (err: any) {
    return json({ ok: false, erro: err?.message ?? String(err) }, 500);
  }
}

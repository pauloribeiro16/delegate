/**
 * Mensagens do painel web (Vercel): entram no mesmo tratador que o Telegram.
 *   POST /api/canal/mensagem  { codigo, texto? , botao? }
 */
import { kernel, json, corpoJson, preflight } from '../_kernel.ts';

export const config = { maxDuration: 60 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ erro: 'só POST' }, 405);
  try {
    const corpo = await corpoJson<{ codigo?: string; texto?: string; botao?: string }>(req);
    const codigo = corpo.codigo?.trim().toLowerCase() ?? '';
    const texto = corpo.texto?.trim() ?? '';
    const botao = corpo.botao?.trim() ?? '';
    if (!codigo) throw new Error('Falta o código da sessão (ligue primeiro o Telegram)');
    if (!texto && !botao) throw new Error('Mensagem vazia: indique «texto» ou «botao»');
    if (texto && botao) throw new Error('Indique só uma coisa: «texto» ou «botao»');
    const k = await kernel();
    await k.aoReceberCanalWeb({ codigo, texto: texto || undefined, botao: botao || undefined });
    return json({ ok: true, aceite: true });
  } catch (err: any) {
    return json({ erro: err?.message ?? String(err) }, 400);
  }
}

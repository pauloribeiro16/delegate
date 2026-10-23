/**
 * Entrada do canal web no Vercel: a mesma rota que o núcleo local serve.
 *   GET  /api/canal/ligacao?codigo=…  — estado da ligação de uma sessão
 *   POST /api/canal/ligacao           — cria um código de ligação
 */
import { kernel, json, preflight } from '../_kernel.ts';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  try {
    const k = await kernel();
    if (req.method === 'POST') {
      return json({ ok: true, codigo: k.criarLigacaoWeb() });
    }
    const codigo = (new URL(req.url).searchParams.get('codigo') ?? '').toLowerCase();
    const ligacao = codigo ? k.obterLigacaoWeb(codigo) : null;
    return json({ ok: true, ligada: Boolean(ligacao), pessoa: ligacao?.pessoa ?? null });
  } catch (err: any) {
    return json({ erro: err?.message ?? String(err) }, 500);
  }
}

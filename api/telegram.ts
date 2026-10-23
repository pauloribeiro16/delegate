/**
 * Webhook do Telegram (Vercel).
 *
 * O Telegram entrega cada atualização aqui; o kernel processa-a pelo MESMO
 * tratador que o painel usa. O long polling é só para o modo local.
 *
 * Registo do webhook (uma vez após o deploy):
 *   GET /api/telegram — instala o webhook deste domínio no bot.
 *   POST /api/telegram — entrada das atualizações (chamado pelo Telegram).
 */
import { kernel, json } from './_kernel.js';

export const config = { maxDuration: 30 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'GET') {
    // Instalar o webhook no endereço onde esta função corre.
    try {
      const k = await kernel();
      const url = new URL(req.url);
      const webhook = `${url.origin}/api/telegram`;
      await k.canalTelegram._bot().api.setWebhook(webhook, { drop_pending_updates: false, secret_token: undefined });
      return json({ ok: true, webhook });
    } catch (err: any) {
      return json({ ok: false, erro: err?.message ?? String(err) }, 500);
    }
  }

  if (req.method !== 'POST') return json({ ok: false, erro: 'só GET (instalar) ou POST (atualizações)' }, 405);

  try {
    const atualizacao = await req.json();
    const k = await kernel();
    await k.processarAtualizacaoTelegram(atualizacao);
    return json({ ok: true });
  } catch (err: any) {
    // O Telegram repete se falhar; registamos mas respondemos 200 para não
    // criar tempestades de repetição quando o erro é nosso e permanente.
    console.error('✖ webhook telegram:', err?.message ?? err);
    return json({ ok: true, nota: 'erro registado', detalhe: err?.message ?? String(err) });
  }
}

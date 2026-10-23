/**
 * A Porta Agêntica no Vercel: o mesmo servidor MCP + REST do processo local,
 * sem processo vivo. A fronteira mantém-se pela rede — o núcleo chega aqui
 * como cliente MCP através de PORTA_MCP_URL.
 *
 *   POST /api/porta/mcp            — protocolo MCP (streamable HTTP)
 *   GET  /api/porta/mcp            — sessão/estado do MCP
 *   GET  /api/porta/ferramentas    — listagem REST das ferramentas
 *
 * O estado dos processos do SU persiste na base alojada (su_simulado.processos).
 */
import pg from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { criarServidorPorta } from '../../apps/api/src/porta/servidor.ts';
import { CatalogoPorta } from '../../apps/api/src/porta/servicos.ts';
import { Registo } from '../../apps/api/src/nucleo/eventos/registo.ts';
import { servicosUrbanos } from '../../apps/api/src/su/processos.ts';
import { raizPrototipo } from '../../apps/api/src/nucleo/dados-raiz.ts';
import { join } from 'node:path';

export const config = { runtime: 'nodejs', maxDuration: 60 };

interface InstanciaPorta {
  processarPedido: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  pool: pg.Pool;
}

const globalPorta = globalThis as unknown as { __portaInstancia?: Promise<InstanciaPorta> };

function porta(): Promise<InstanciaPorta> {
  if (!globalPorta.__portaInstancia) {
    globalPorta.__portaInstancia = (async () => {
      const url = process.env.DATABASE_URL?.trim();
      if (!url) throw new Error('Falta DATABASE_URL — a Porta alojada corre sobre a base externa');
      const ssl = url.includes('sslmode=') ? {} : { ssl: { rejectUnauthorized: false } };
      const pool = new pg.Pool({ connectionString: url, max: 3, ...ssl });
      pool.on('error', (err: Error) => console.warn('⚠ aviso no pool pg da Porta:', err.message));
      const registo = new Registo(pool as never);
      const instancia = await criarServidorPorta({
        registoEventos: registo,
        catalogo: new CatalogoPorta(join(raizPrototipo(), 'registo')),
        sessao: process.env.SESSAO ?? 'demo',
      });
      await servicosUrbanos.carregar(pool);
      console.log(`✓ Porta Agêntica alojada pronta (${instancia.catalogo.total} serviços no catálogo)`);
      return { processarPedido: instancia.processarPedido, pool };
    })();
  }
  return globalPorta.__portaInstancia;
}

export default async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { processarPedido, pool } = await porta();
    // O despacho da porta reconhece /mcp e /ferramentas: traduzir os percursos
    // da função (/api/porta/…) para os da porta.
    const caminho = new URL(req.url ?? '/', 'http://interno').pathname;
    const pergunta = new URL(req.url ?? '/', 'http://interno').search ?? '';
    if (caminho.endsWith('/ferramentas')) {
      (req as { url?: string }).url = `/ferramentas${pergunta}`;
    } else {
      (req as { url?: string }).url = `/mcp${pergunta}`;
    }
    await processarPedido(req, res);
    // Os processos do SU mudam dentro do despacho: gravar de volta na base.
    await servicosUrbanos.persistir(pool).catch((err: unknown) => {
      console.warn('⚠ persistência do SU:', (err as Error).message);
    });
  } catch (err: any) {
    console.error('✖ função da Porta:', err?.message ?? err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ erro: err?.message ?? String(err) }));
    } else {
      res.end();
    }
  }
}

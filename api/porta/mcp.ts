/**
 * A Porta Agêntica no Vercel: o mesmo servidor MCP do processo local, sem
 * processo vivo. A fronteira mantém-se pela rede — o núcleo chega aqui como
 * cliente MCP através de PORTA_MCP_URL.
 *
 *   POST /api/porta/mcp — protocolo MCP (streamable HTTP)
 *   GET  /api/porta/mcp — abertura de sessão SSE do MCP
 *
 * O estado dos processos do SU persiste na base alojada (su_simulado.processos).
 */
import { join } from 'node:path';

export const config = { maxDuration: 60 };

interface InstanciaPorta {
  mcpHandler: { fetch(req: Request): Promise<Response> };
  persistirSU: () => Promise<void>;
}

const globalPorta = globalThis as unknown as { __portaInstancia?: Promise<InstanciaPorta> };

function porta(): Promise<InstanciaPorta> {
  if (!globalPorta.__portaInstancia) {
    globalPorta.__portaInstancia = (async () => {
      const url = process.env.DATABASE_URL?.trim();
      if (!url) throw new Error('Falta DATABASE_URL — a Porta alojada corre sobre a base externa');
      // Importações preguiçosas: o erro real sai como JSON, não como falha cega.
      const { criarServidorPorta } = await import('../../prototipo/apps/api/src/porta/servidor.js');
      const { CatalogoPorta } = await import('../../prototipo/apps/api/src/porta/servicos.js');
      const { Registo } = await import('../../prototipo/apps/api/src/nucleo/eventos/registo.js');
      const { servicosUrbanos } = await import('../../prototipo/apps/api/src/su/processos.js');
      const { raizPrototipo } = await import('../../prototipo/apps/api/src/nucleo/dados-raiz.js');
      const pg = (await import('pg')).default;
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
      return {
        mcpHandler: instancia.mcpHandler,
        persistirSU: () => servicosUrbanos.persistir(pool),
      };
    })();
  }
  return globalPorta.__portaInstancia;
}

async function tratar(req: Request): Promise<Response> {
  try {
    const { mcpHandler, persistirSU } = await porta();
    // O handler MCP reconhece /mcp: traduzir o percurso da função.
    const url = new URL(req.url);
    const pedido = new Request(`${url.origin}/mcp${url.search}`, req);
    const resposta = await mcpHandler.fetch(pedido);
    // Os processos do SU mudam dentro do despacho: gravar de volta na base.
    await persistirSU().catch((err: unknown) => {
      console.warn('⚠ persistência do SU:', (err as Error).message);
    });
    return resposta;
  } catch (err: any) {
    console.error('✖ função da Porta:', err?.message ?? err);
    return new Response(JSON.stringify({ erro: err?.message ?? String(err) }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

export async function GET(req: Request): Promise<Response> {
  return tratar(req);
}

export async function POST(req: Request): Promise<Response> {
  return tratar(req);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

/**
 * Kernel partilhado pelas funções serverless.
 *
 * Uma instância de função constrói o kernel uma vez e reutiliza-o entre
 * pedidos (o runtime mantém a instância quente). A base é sempre externa:
 * sem DATABASE_URL não há como correr aqui — o modo embutido é só local.
 */
import { abrirBase, URL_BASE_EXTERNA } from '../apps/api/src/nucleo/bd.ts';
import { criarKernel, type Kernel } from '../apps/api/src/nucleo/kernel.ts';

const globalKernel = globalThis as unknown as { __kernelDelegate?: Promise<Kernel> };

export function kernel(): Promise<Kernel> {
  if (!globalKernel.__kernelDelegate) {
    globalKernel.__kernelDelegate = (async () => {
      if (!URL_BASE_EXTERNA) {
        throw new Error(
          'Falta DATABASE_URL no ambiente — as funções do Vercel correm apenas em modo alojado (Neon/Vercel Postgres)',
        );
      }
      const k = await criarKernel({
        base: await abrirBase(),
        tokenTelegram: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? null,
        canalWebAutoLigar: process.env.CANAL_WEB === '1',
      });
      console.log('✓ kernel do núcleo pronto (modo alojado)');
      return k;
    })();
  }
  return globalKernel.__kernelDelegate;
}

export function json(dados: unknown, estado = 200): Response {
  return new Response(JSON.stringify(dados), {
    status: estado,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

export async function corpoJson<T>(req: Request): Promise<T> {
  try {
    return JSON.parse(await req.text()) as T;
  } catch {
    throw new Error('corpo JSON inválido');
  }
}

export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

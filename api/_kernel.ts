/**
 * Kernel partilhado pelas funções serverless.
 *
 * Uma instância de função constrói o kernel uma vez e reutiliza-o entre
 * pedidos (o runtime mantém a instância quente). A base é sempre externa:
 * sem DATABASE_URL não há como correr aqui — o modo embutido é só local.
 */
const globalKernel = globalThis as unknown as { __kernelDelegate?: Promise<any> };

export function kernel(): Promise<any> {
  if (!globalKernel.__kernelDelegate) {
    globalKernel.__kernelDelegate = (async () => {
      if (!process.env.DATABASE_URL?.trim()) {
        throw new Error(
          'Falta DATABASE_URL no ambiente — as funções do Vercel correm apenas em modo alojado (Neon/Vercel Postgres)',
        );
      }
      // Importações preguiçosas a propósito: um erro a carregar o grafo do
      // núcleo sai como JSON desta função, não como FUNCTION_INVOCATION_FAILED
      // sem explicação.
      const { abrirBase } = await import('../prototipo/apps/api/src/nucleo/bd.js');
      const { criarKernel } = await import('../prototipo/apps/api/src/nucleo/kernel.js');
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

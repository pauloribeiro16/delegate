/**
 * Diagnóstico: a função mais simples possível. Se /api/ping falhar, o problema
 * é do deployment; se responder, é do grafo do kernel. Retirar depois.
 */
export const config = { maxDuration: 10 };

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ pong: true, quando: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

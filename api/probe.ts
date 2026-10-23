/**
 * Diagnóstico da implantação: testa cada importação do kernel numa função
 * própria e diz qual falha. Retirar depois de estabilizar.
 */
export const config = { maxDuration: 30 };

export default async function (): Promise<Response> {
  const passos: Record<string, string> = {};
  const tentar = async (nome: string, fabrica: () => Promise<unknown>) => {
    try {
      await fabrica();
      passos[nome] = 'ok';
    } catch (err: any) {
      passos[nome] = `${err?.message ?? String(err)}`;
    }
  };

  const indireto = (caminho: string) => import(/* caminho dinâmico */ caminho);

  await tentar('pg', () => indireto('pg'));
  await tentar('grammy', () => indireto('grammy'));
  await tentar('zod', () => indireto('zod'));
  await tentar('mcp-server', () => indireto('@modelcontextprotocol/server'));
  await tentar('mcp-client', () => indireto('@modelcontextprotocol/client'));
  await tentar('eventos', () => indireto('../prototipo/packages/eventos/src/index.ts'));
  await tentar('dados-raiz', () => indireto('../prototipo/apps/api/src/nucleo/dados-raiz.ts'));
  await tentar('bd', () => indireto('../prototipo/apps/api/src/nucleo/bd.ts'));
  await tentar('canal', () => indireto('../prototipo/apps/api/src/nucleo/canal.ts'));
  await tentar('registo', () => indireto('../prototipo/apps/api/src/nucleo/eventos/registo.ts'));
  await tentar('henriques', () => indireto('../prototipo/apps/api/src/nucleo/henriques/henriques.ts'));
  await tentar('buscador', () => indireto('../prototipo/apps/api/src/nucleo/conhecimento/buscador.ts'));
  await tentar('kernel', () => indireto('../prototipo/apps/api/src/nucleo/kernel.ts'));

  return new Response(JSON.stringify(passos, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

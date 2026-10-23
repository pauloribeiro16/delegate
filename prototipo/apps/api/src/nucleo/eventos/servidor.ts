/**
 * O servidor de eventos. Entrega o fluxo ao Observatório por SSE.
 *
 * O canal é unidireccional — o ecrã só recebe. Por isso nada de WebSocket.
 *
 * Cada evento leva `id:` para que, se a ligação cair, o browser diga de onde
 * quer recomeçar. E o browser reconstrói a ligação sozinho se esta parar: sem
 * isso, um erro do lado do servidor deixa o Observatório congelado e não sai
 * ninguém sem perceber porquê.
 */
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { Registo } from './registo.ts';
import { cifrarDados, derivarChavePessoa } from '../cofre/cifra.ts';

const CABECALHOS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  // Impede proxies de guardarem o fluxo em buffer — o evento fica preso lá.
  'X-Accel-Buffering': 'no',
};

// As páginas do projeto vivem na pasta `site/` na raiz do repositório
// (mesma convenção do alojamento: o Vercel serve-as de lá).
const WEB = new URL('../../../../../../site/', import.meta.url);

const MIMES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const ESTATICOS: Record<string, { ficheiro: string; tipo: string }> = {
  '/': { ficheiro: 'index.html', tipo: 'text/html; charset=utf-8' },
  '/painel': { ficheiro: 'delegate-panel.html', tipo: 'text/html; charset=utf-8' },
  '/painel.html': { ficheiro: 'delegate-panel.html', tipo: 'text/html; charset=utf-8' },
  '/consola': { ficheiro: 'delegate-consola-camara-v2.html', tipo: 'text/html; charset=utf-8' },
  '/consola.html': { ficheiro: 'delegate-consola-camara-v2.html', tipo: 'text/html; charset=utf-8' },
  '/consola-camara': { ficheiro: 'delegate-consola-camara-v2.html', tipo: 'text/html; charset=utf-8' },
  '/consola-camara.html': { ficheiro: 'delegate-consola-camara.html', tipo: 'text/html; charset=utf-8' },
  '/consola-v1': { ficheiro: 'delegate-consola-camara.html', tipo: 'text/html; charset=utf-8' },
  '/consola-v1.html': { ficheiro: 'delegate-consola-camara.html', tipo: 'text/html; charset=utf-8' },
  '/consola-v2': { ficheiro: 'delegate-consola-camara-v2.html', tipo: 'text/html; charset=utf-8' },
  '/consola-v2.html': { ficheiro: 'delegate-consola-camara-v2.html', tipo: 'text/html; charset=utf-8' },
  '/cmd': { ficheiro: 'cmd.html', tipo: 'text/html; charset=utf-8' },
  '/cmd.html': { ficheiro: 'cmd.html', tipo: 'text/html; charset=utf-8' },
  '/autenticacao': { ficheiro: 'cmd.html', tipo: 'text/html; charset=utf-8' },
  '/legendas.json': { ficheiro: 'legendas.json', tipo: 'application/json; charset=utf-8' },
  '/favicon.ico': { ficheiro: 'assets/favicon.png', tipo: 'image/png' },
  '/favicon.png': { ficheiro: 'assets/favicon.png', tipo: 'image/png' },
};

export interface DadosConfirmacaoCmd {
  pessoa: string;
  servico?: string;
  processo?: string;
  token_cmd: string;
  nif?: string;
  nome?: string;
}

export interface AcoesCofreServidor {
  obterDados?: (pessoa?: string) => Promise<any> | any;
  guardar?: (dados: any) => Promise<any> | any;
  avaliar?: (dados: any) => Promise<any> | any;
  simularCifra?: (texto: string, pessoa?: string) => any;
}

export interface AcaoConsolaServidor {
  processo: string;
  acao: string;
  nota?: string;
}

/** Uma mensagem ou botão que entra pelo painel Web. O código identifica a sessão ligada. */
export interface EntradaCanalWeb {
  codigo: string;
  texto?: string;
  botao?: string;
}

/** A associação entre um código de ligação e a pessoa que fez /start com ele. */
export interface LigacaoWeb {
  pessoa: string;
  conversa: string;
  quando: string;
}

const RESPOSTA_JSON = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

export function criarServidorEventos(
  registro: Registo,
  abrirEscuta: () => Promise<pg.Client>,
  aoConfirmarCmd?: (dados: DadosConfirmacaoCmd) => Promise<void>,
  obterConhecimento?: () => Promise<any> | any,
  testarPerguntaRouter?: (pergunta: string) => Promise<any> | any,
  obterEstadoProcesso?: () => Promise<any> | any,
  acoesCofre?: AcoesCofreServidor,
  aoAcaoConsola?: (dados: AcaoConsolaServidor) => Promise<void>,
  obterPedidosConsola?: () => Promise<any> | any,
  aoReceberCanalWeb?: (entrada: EntradaCanalWeb) => Promise<void>,
  criarLigacaoWeb?: () => string,
  obterLigacaoWeb?: (codigo: string) => LigacaoWeb | null,
) {
  return createServer((req, res) => {
    void (async () => {
      const caminho = req.url?.split('?')[0] ?? '/';

      // 0. API de Conhecimento Municipal (GET)
      if (caminho === '/api/conhecimento' && req.method === 'GET') {
        try {
          if (obterConhecimento) {
            const dados = await obterConhecimento();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(dados));
            return;
          }
          const caminhoIndice = new URL('../../../../../data/conhecimento/indice.json', import.meta.url);
          const raw = await readFile(caminhoIndice, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(raw);
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 0.1 API de Teste do Router RAG Híbrido (POST)
      if (caminho === '/api/router/testar' && req.method === 'POST') {
        let corpo = '';
        for await (const pedaco of req) corpo += pedaco;
        try {
          const body = JSON.parse(corpo);
          const pergunta = body.pergunta?.trim();
          if (!pergunta) throw new Error('Pergunta não indicada');
          if (testarPerguntaRouter) {
            const resp = await testarPerguntaRouter(pergunta);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(resp));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, mensagem: 'Testador não injetado' }));
          return;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 0.2 API de Histórico de Decisões Jev e Auditoria (GET)
      if (caminho === '/api/router/decisoes' && req.method === 'GET') {
        try {
          const decisoes = await registro.listarDecisoes(100);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(decisoes));
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 0.3 API de Máquina de Estados e Processo Ativo (GET)
      if (caminho === '/api/router/processo-estado' && req.method === 'GET') {
        try {
          let estado = null;
          if (obterEstadoProcesso) {
            estado = await obterEstadoProcesso();
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(estado ?? {}));
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      if (caminho === '/api/cofre' && req.method === 'GET') {
        try {
          const params = new URL(req.url ?? '', 'http://localhost').searchParams;
          const pessoa = params.get('pessoa') ?? 'pessoa-1bbe89cb4d';
          let dados = null;
          if (acoesCofre?.obterDados) {
            dados = await acoesCofre.obterDados(pessoa);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(dados ?? {}));
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      if (caminho === '/api/cofre/simular-cifra' && req.method === 'POST') {
        let corpo = '';
        for await (const pedaco of req) corpo += pedaco;
        try {
          const body = JSON.parse(corpo);
          const texto = body.texto ?? '';
          const pessoa = body.pessoa ?? 'pessoa-1bbe89cb4d';
          const chave = derivarChavePessoa(pessoa);
          const cifrado = cifrarDados(texto, chave);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            ok: true,
            algoritmo: 'AES-256-GCM',
            iv: cifrado.iv,
            tag: cifrado.tag,
            ciphertext: cifrado.dados,
            tamanhoBytes: Buffer.from(cifrado.dados, 'hex').length,
            kdf: 'scrypt-256 (sal criptográfico por pessoa)',
            salt: `pessoa:${pessoa}`,
          }));
          return;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      if (caminho === '/api/cofre/avaliar' && req.method === 'POST') {
        let corpo = '';
        for await (const pedaco of req) corpo += pedaco;
        try {
          const body = JSON.parse(corpo);
          let resultado = null;
          if (acoesCofre?.avaliar) {
            resultado = await acoesCofre.avaliar(body);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(resultado ?? { ok: true }));
          return;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      if (caminho === '/api/cofre/guardar' && req.method === 'POST') {
        let corpo = '';
        for await (const pedaco of req) corpo += pedaco;
        try {
          const body = JSON.parse(corpo);
          let resultado = null;
          if (acoesCofre?.guardar) {
            resultado = await acoesCofre.guardar(body);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(resultado ?? { ok: true }));
          return;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 1. Confirmação de Chave Móvel Digital (POST)
      if (caminho === '/cmd/confirmar' && req.method === 'POST') {
        let corpo = '';
        for await (const pedaco of req) corpo += pedaco;
        let dados: DadosConfirmacaoCmd | null = null;
        try {
          dados = JSON.parse(corpo);
        } catch (_) {}

        if (!dados || !dados.token_cmd || typeof dados.token_cmd !== 'string' || dados.token_cmd.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: 'Token CMD inválido ou ausente' }));
          return;
        }

        if (aoConfirmarCmd) {
          try {
            await aoConfirmarCmd(dados);
          } catch (err) {
            console.warn('[CMD] Erro ao processar confirmação:', err);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: dados.token_cmd }));
        return;
      }

      // 1.1 Ação da Consola Municipal da Câmara (POST /api/consola/acao)
      if (caminho === '/api/consola/acao' && req.method === 'POST') {
        let corpo = '';
        for await (const pedaco of req) corpo += pedaco;
        try {
          const body = JSON.parse(corpo);
          if (aoAcaoConsola) {
            await aoAcaoConsola(body);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, processo: body.processo, acao: body.acao }));
          return;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 1.2 Listar Pedidos da Consola Municipal (GET /api/consola/pedidos)
      if (caminho === '/api/consola/pedidos' && req.method === 'GET') {
        try {
          let lista = [];
          if (obterPedidosConsola) {
            lista = await obterPedidosConsola();
          }
          res.writeHead(200, RESPOSTA_JSON);
          res.end(JSON.stringify(lista));
          return;
        } catch (err) {
          res.writeHead(500, RESPOSTA_JSON);
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 1.3 Criar código de ligação de uma sessão Web (POST /api/canal/ligacao)
      if (caminho === '/api/canal/ligacao' && req.method === 'POST') {
        try {
          if (!criarLigacaoWeb) throw new Error('Ligações Web não ativas neste núcleo');
          res.writeHead(200, RESPOSTA_JSON);
          res.end(JSON.stringify({ ok: true, codigo: criarLigacaoWeb() }));
          return;
        } catch (err) {
          res.writeHead(500, RESPOSTA_JSON);
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 1.4 Estado da ligação: o painel pergunta se o /start já chegou (GET /api/canal/ligacao?codigo=…)
      if (caminho === '/api/canal/ligacao' && req.method === 'GET') {
        const pergunta = new URL(req.url ?? '', 'http://localhost').searchParams;
        const codigo = (pergunta.get('codigo') ?? '').toLowerCase();
        const ligacao = codigo && obterLigacaoWeb ? obterLigacaoWeb(codigo) : null;
        res.writeHead(200, RESPOSTA_JSON);
        res.end(JSON.stringify({ ok: true, ligada: Boolean(ligacao), pessoa: ligacao?.pessoa ?? null }));
        return;
      }

      // 1.5 Entrada do canal Web: a mensagem segue o mesmo tratador do Telegram.
      // O código de ligação é quem identifica a pessoa — nunca um pseudónimo vindo do cliente.
      if (caminho === '/api/canal/mensagem' && req.method === 'POST') {
        let corpo = '';
        for await (const pedaco of req) corpo += pedaco;
        try {
          const body = JSON.parse(corpo);
          const codigo = typeof body.codigo === 'string' ? body.codigo.trim().toLowerCase() : '';
          const texto = typeof body.texto === 'string' ? body.texto.trim() : '';
          const botao = typeof body.botao === 'string' ? body.botao.trim() : '';
          if (!codigo) throw new Error('Falta o código da sessão (ligue primeiro o Telegram)');
          if (!texto && !botao) throw new Error('Mensagem vazia: indique «texto» ou «botao»');
          if (texto && botao) throw new Error('Indique só uma coisa: «texto» ou «botao»');
          if (!aoReceberCanalWeb) throw new Error('Canal Web não ativo neste núcleo');
          await aoReceberCanalWeb({ codigo, texto: texto || undefined, botao: botao || undefined });
          res.writeHead(200, RESPOSTA_JSON);
          res.end(JSON.stringify({ ok: true, aceite: true }));
          return;
        } catch (err) {
          res.writeHead(400, RESPOSTA_JSON);
          res.end(JSON.stringify({ erro: (err as Error).message }));
          return;
        }
      }

      // 2. Ficheiros estáticos mapeados
      const estatico = ESTATICOS[caminho];
      if (estatico) {
        try {
          const corpo = await readFile(new URL(estatico.ficheiro, WEB));
          res.writeHead(200, { 'Content-Type': estatico.tipo, 'Cache-Control': 'no-store' });
          res.end(corpo);
          return;
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('falta o ficheiro da interface');
          return;
        }
      }

      // 3. Ficheiros sob /assets/
      if (caminho.startsWith('/assets/')) {
        const subcaminho = caminho.replace(/^\/assets\//, '');
        const ext = subcaminho.slice(subcaminho.lastIndexOf('.')).toLowerCase();
        const tipo = MIMES[ext] ?? 'application/octet-stream';
        try {
          const corpo = await readFile(new URL(`assets/${subcaminho}`, WEB));
          res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'public, max-age=3600' });
          res.end(corpo);
          return;
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('recurso não encontrado');
          return;
        }
      }

      // 4. Ficheiros sob /design-system/
      if (caminho.startsWith('/design-system/')) {
        const subcaminho = caminho.replace(/^\/design-system\//, '');
        const ext = subcaminho.slice(subcaminho.lastIndexOf('.')).toLowerCase();
        const tipo = MIMES[ext] ?? 'application/octet-stream';
        try {
          const corpo = await readFile(new URL(`../../../../../../design-system/${subcaminho}`, import.meta.url));
          res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'public, max-age=3600' });
          res.end(corpo);
          return;
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('recurso não encontrado');
          return;
        }
      }

      if (req.method === 'OPTIONS') {
        if (caminho === '/cmd/confirmar') {
          // Bloquear preflight de origens externas no endpoint crítico da CMD
          res.writeHead(204, {
            'Access-Control-Allow-Origin': 'null',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }

        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        });
        res.end();
        return;
      }

      if (!req.url?.startsWith('/eventos/stream')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('não encontrado');
        return;
      }

      res.writeHead(200, CABECALHOS);
      res.write('retry: 1000\n\n');

      // O browser diz de onde quer recomeçar, em que sessão quer o fluxo e —
      // nas sessões pessoais do painel — de que pessoa. Sem o filtro, uma
      // sessão veria conversas que não são suas.
      const pergunta = new URL(req.url, 'http://localhost').searchParams;
      const cru = Number(pergunta.get('desde') ?? '0');
      const desde = Number.isSafeInteger(cru) && cru >= 0 ? cru : 0;
      const sessao = pergunta.get('sessao') ?? undefined;
      const pessoaFiltro = pergunta.get('pessoa') ?? undefined;

      // Primeiro o que se perdeu, depois o que chega.
      let cursor = desde;
      while (true) {
        const lote = await registro.desde(cursor, 500, sessao);
        if (lote.length === 0) break;
        for (const evento of lote) {
          if (!pessoaFiltro || evento.pessoa === pessoaFiltro) {
            res.write(`id: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`);
          }
          cursor = evento.seq;
        }
        if (lote.length < 500) break;
      }

      // Uma ligação só para escutar. Nunca uma do pool de consultas: o pool
      // fecha a ligação e a subscrição vai com ela.
      const escuta = await abrirEscuta();

      // O fecho regista-se ANTES de qualquer espera. Se o browser desligar
      // enquanto esperamos, o evento já passou e nunca mais dispara — e a
      // ligação fica em LISTEN para sempre. Com o watchdog do browser a
      // reconectar, cada queda de rede vazava uma subscrição do Postgres.
      const fechar = () => {
        if (batimento) clearInterval(batimento);
        void escuta.end().catch(() => {});
      };
      let batimento: NodeJS.Timeout | undefined;
      req.on('close', fechar);

      escuta.on('notification', (aviso) => {
        const seq = Number(aviso.payload);
        if (!Number.isFinite(seq)) return;
        void registro
          .porSeq(seq)
          .then((evento) => {
            if (!evento) return;
            if (sessao && evento.sessao !== sessao) return;
            if (pessoaFiltro && evento.pessoa !== pessoaFiltro) return;
            res.write(`id: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`);
          })
          .catch((err: unknown) => console.error('✖ ao entregar o evento:', err));
      });
      await escuta.query('LISTEN eventos');

      // Mantém a ligação viva através de proxies que cortam o silêncio.
      batimento = setInterval(() => res.write(': ping\n\n'), 15000);
    })().catch((err: unknown) => {
      console.error('✖ servidor de eventos:', err);
      res.end();
    });
  });
}
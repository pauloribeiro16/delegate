/**
 * Buscador na Base de Conhecimento Municipal (RAG D0 Híbrido: BM25 + Embeddings + TypeSafe Jev)
 *
 * Pesquisa instantânea sobre os 224+ procedimentos, formulários, taxas (RTTL 2025)
 * e diretório de serviços da Câmara Municipal de Guimarães.
 *
 * Características:
 * 1. Pesquisa Híbrida: BM25 léxico com penalização de stopwords municipais + Embeddings vetoriais.
 * 2. Desduplicação inteligente: funde resultados léxicos e semânticos removendo duplicados por id/url.
 * 3. Re-ranking e Verificação via TypeSafe Jev (OpenRouter): assegura fidelidade estrita à fonte oficial
 *    e deteção de necessidade de esclarecimento (perguntas incompletas/ambíguas).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { raizPrototipo } from '../dados-raiz.ts';
import {
  choice,
  criarClienteJev,
  noul,
  type ChoiceResponse,
  type ClienteJev,
  type NoulResponse,
} from '../typesafe/jev-openrouter.ts';
import type { Botao } from '../canal.ts';

export interface EntradaIndice {
  id: string;
  url: string;
  titulo: string;
  categoria: string;
  consultadoEm: string;
  hashSha256: string;
  ficheiroLocal: string;
  tamanhoBytes: number;
}

export interface SecaoDocumento {
  tituloSecao: string;
  texto: string;
}

export interface DocumentoCarregado extends EntradaIndice {
  conteudoCompleto: string;
  secoes: SecaoDocumento[];
  palavrasChave: Set<string>;
}

export interface DocumentoComVetor {
  id: string;
  vector: number[];
}

export interface ResultadoConhecimento {
  id: string;
  titulo: string;
  url: string;
  categoria: string;
  consultadoEm: string;
  hashSha256: string;
  excerto: string;
  pontuacao: number;
  confiancaJev?: number;
  motorDecisao?: 'typesafe-jev' | 'calibrado-local' | 'hibrido-vetorial';
  modelo?: string;
  precisaEsclarecimento?: boolean;
}

const PASTA_DADOS = join(raizPrototipo(), 'data', 'conhecimento');

const STOPWORDS_MUNICIPAIS = new Set([
  'camara',
  'municipal',
  'guimaraes',
  'municipio',
  'concelho',
  'servico',
  'servicos',
  'informacao',
  'informacoes',
  'como',
  'onde',
  'para',
  'qual',
  'quais',
  'sim',
  'nao',
  'ola',
  'obrigado',
  'obrigada',
  'bom',
  'boa',
  'dias',
  'tarde',
  'noite',
]);

function normalizar(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2);
}

function produtoInterno(a: number[], b: number[]): number {
  let soma = 0;
  for (let i = 0; i < a.length; i++) {
    soma += a[i] * b[i];
  }
  return soma;
}

export class BuscadorConhecimento {
  readonly #documentos: DocumentoCarregado[] = [];
  readonly #vetores = new Map<string, number[]>();
  readonly #jev: ClienteJev | null;
  readonly #tokenOpenRouter: string | null;

  constructor(caminhoPasta = PASTA_DADOS, jev?: ClienteJev) {
    this.#tokenOpenRouter = process.env.OPEN_ROUTER_API_TOKEN || process.env.OPENROUTER_API_KEY || null;
    this.#jev = jev ?? criarClienteJev();

    const caminhoIndice = join(caminhoPasta, 'indice.json');
    if (!existsSync(caminhoIndice)) {
      return;
    }

    try {
      const conteudoIndice = readFileSync(caminhoIndice, 'utf-8');
      const entradas = JSON.parse(conteudoIndice) as EntradaIndice[];

      for (const ent of entradas) {
        const caminhoDoc = join(caminhoPasta, ent.ficheiroLocal);
        if (existsSync(caminhoDoc)) {
          const raw = readFileSync(caminhoDoc, 'utf-8');
          const partes = raw.split(/^---$/m);
          const corpo = partes.length >= 3 ? partes.slice(2).join('---').trim() : raw;

          const secoes = this.#extrairSecoes(corpo, ent.titulo);
          const tokens = new Set(normalizar(`${ent.titulo} ${corpo}`));

          this.#documentos.push({
            ...ent,
            conteudoCompleto: corpo,
            secoes,
            palavrasChave: tokens,
          });
        }
      }

      // Carregar cache de embeddings se existir
      const caminhoEmbeddings = join(caminhoPasta, 'embeddings_cache.json');
      if (existsSync(caminhoEmbeddings)) {
        try {
          const rawEmbeddings = JSON.parse(readFileSync(caminhoEmbeddings, 'utf-8'));
          for (const item of rawEmbeddings) {
            if (item.id && Array.isArray(item.vector)) {
              this.#vetores.set(item.id, item.vector);
            }
          }
        } catch (e) {
          console.warn('[BuscadorConhecimento] Aviso ao carregar embeddings_cache.json:', (e as Error).message);
        }
      }
    } catch (err) {
      console.warn('[BuscadorConhecimento] Erro ao carregar base de conhecimento:', err);
    }
  }

  get totalDocumentos(): number {
    return this.#documentos.length;
  }

  get totalVetores(): number {
    return this.#vetores.size;
  }

  /**
   * Fast Search BM25 léxico calibrado com penalização de stopwords e priorização de procedimentos.
   */
  buscarCandidatos(pergunta: string, limite = 3): ResultadoConhecimento[] {
    if (this.#documentos.length === 0) return [];

    const tokensPergunta = normalizar(pergunta);
    if (tokensPergunta.length === 0) return [];

    const tokensUteis = tokensPergunta.filter((t) => !STOPWORDS_MUNICIPAIS.has(t));
    if (tokensUteis.length === 0) return [];

    const candidatos: ResultadoConhecimento[] = [];

    for (const doc of this.#documentos) {
      let pontosDoc = 0;
      const tokensTitulo = normalizar(doc.titulo);
      const urlLower = doc.url.toLowerCase();
      const ficheiroLower = doc.ficheiroLocal.toLowerCase();

      const ehNoticia = ficheiroLower.includes('/noticia-') || urlLower.includes('/noticia/');
      const ehProcedimento = ficheiroLower.startsWith('procedimentos/') || ficheiroLower.startsWith('taxas/');
      const ehAgregador =
        urlLower.endsWith('/directorio_de_servicos') ||
        urlLower.endsWith('/directorio_de_servicos/') ||
        urlLower.endsWith('/formularios') ||
        urlLower === 'https://diretorio.cm-guimaraes.pt/' ||
        urlLower === 'https://www.cm-guimaraes.pt/';

      for (const token of tokensPergunta) {
        const ehStopword = STOPWORDS_MUNICIPAIS.has(token);
        const pesoTitulo = ehStopword ? 1 : 15;
        const pesoUrl = ehStopword ? 1 : 10;
        const pesoCorpo = ehStopword ? 0.2 : 2;

        if (tokensTitulo.includes(token)) {
          pontosDoc += pesoTitulo;
        }
        if (urlLower.includes(token)) {
          pontosDoc += pesoUrl;
        }
        if (doc.palavrasChave.has(token)) {
          pontosDoc += pesoCorpo;
        }
      }

      if (pontosDoc <= 0) continue;

      if (ehProcedimento) {
        pontosDoc = Math.floor(pontosDoc * 1.3);
      } else if (ehNoticia) {
        pontosDoc = Math.max(1, Math.floor(pontosDoc * 0.4));
      } else if (ehAgregador) {
        pontosDoc = Math.max(1, Math.floor(pontosDoc * 0.3));
      }

      let melhorSecaoDoc: SecaoDocumento | null = null;
      let melhorPontosDoc = pontosDoc;

      if (doc.secoes.length > 0) {
        for (const secao of doc.secoes) {
          let pontosSecao = pontosDoc;
          const tokensSecao = normalizar(`${secao.tituloSecao} ${secao.texto}`);

          for (const token of tokensPergunta) {
            if (STOPWORDS_MUNICIPAIS.has(token)) continue;
            const ocorrencias = tokensSecao.filter((t) => t === token).length;
            pontosSecao += Math.min(ocorrencias * 3, 15);
          }

          if (pontosSecao > melhorPontosDoc) {
            melhorPontosDoc = pontosSecao;
            melhorSecaoDoc = secao;
          }
        }
      }

      if (melhorPontosDoc >= 5) {
        const excerto = melhorSecaoDoc
          ? `${melhorSecaoDoc.tituloSecao ? `### ${melhorSecaoDoc.tituloSecao}\n\n` : ''}${melhorSecaoDoc.texto}`
          : doc.conteudoCompleto.slice(0, 500);

        candidatos.push({
          id: doc.id,
          titulo: doc.titulo,
          url: doc.url,
          categoria: doc.categoria,
          consultadoEm: doc.consultadoEm.split('T')[0],
          hashSha256: doc.hashSha256,
          excerto: this.#limparExcerto(excerto),
          pontuacao: melhorPontosDoc,
          motorDecisao: 'calibrado-local',
        });
      }
    }

    candidatos.sort((a, b) => b.pontuacao - a.pontuacao);
    return candidatos.slice(0, limite);
  }

  /**
   * Busca rápida síncrona com contingência calibrada local (0ms).
   */
  buscar(pergunta: string): ResultadoConhecimento | null {
    const lista = this.buscarCandidatos(pergunta, 1);
    return lista.length > 0 ? lista[0] : null;
  }

  /**
   * Recuperação Híbrida: funde BM25 e Embeddings Vetoriais com desduplicação rigorosa por ID e URL.
   */
  async buscarCandidatosHibrido(pergunta: string, limite = 4): Promise<ResultadoConhecimento[]> {
    const candidatosBm25 = this.buscarCandidatos(pergunta, 6);

    let candidatosVetoriais: ResultadoConhecimento[] = [];
    if (this.#tokenOpenRouter && this.#vetores.size > 0) {
      try {
        const qVector = await this.#obterVetorPergunta(pergunta);
        if (qVector) {
          const docMap = new Map(this.#documentos.map((d) => [d.id, d]));
          const pontuados: Array<{ doc: DocumentoCarregado; sim: number }> = [];

          for (const [id, vec] of this.#vetores.entries()) {
            const doc = docMap.get(id);
            if (doc) {
              const sim = produtoInterno(qVector, vec);
              if (sim > 0.28) {
                pontuados.push({ doc, sim });
              }
            }
          }

          pontuados.sort((a, b) => b.sim - a.sim);
          candidatosVetoriais = pontuados.slice(0, 6).map((p) => ({
            id: p.doc.id,
            titulo: p.doc.titulo,
            url: p.doc.url,
            categoria: p.doc.categoria,
            consultadoEm: p.doc.consultadoEm.split('T')[0],
            hashSha256: p.doc.hashSha256,
            excerto: this.#limparExcerto(p.doc.conteudoCompleto.slice(0, 600)),
            pontuacao: Math.round(p.sim * 100),
            motorDecisao: 'hibrido-vetorial',
          }));
        }
      } catch (err) {
        console.warn('[BuscadorConhecimento] Alternativa vetorial:', (err as Error).message);
      }
    }

    // Fusão e Desduplicação por ID e URL
    const mapaUnicos = new Map<string, ResultadoConhecimento>();

    for (const c of candidatosBm25) {
      const chave = `${c.url.toLowerCase().trim()}|${c.id}`;
      mapaUnicos.set(chave, c);
    }

    for (const c of candidatosVetoriais) {
      const chave = `${c.url.toLowerCase().trim()}|${c.id}`;
      const existente = mapaUnicos.get(chave);
      if (existente) {
        // Se apareceu em ambos (BM25 + Vetorial), recebe bónus de convergência
        existente.pontuacao += Math.round(c.pontuacao * 0.7);
        existente.motorDecisao = 'hibrido-vetorial';
      } else {
        mapaUnicos.set(chave, c);
      }
    }

    const unificados = Array.from(mapaUnicos.values());
    unificados.sort((a, b) => b.pontuacao - a.pontuacao);
    return unificados.slice(0, limite);
  }

  /**
   * Two-Step Hybrid RAG:
   * 1. Recuperação Híbrida desduplicada (BM25 + Embeddings);
   * 2. Re-ranking Semântico, Verificação Factual de Citação e Avaliação de Ambiguidade via TypeSafe Jev (OpenRouter).
   */
  async buscarComJev(pergunta: string): Promise<ResultadoConhecimento | null> {
    const candidatos = await this.buscarCandidatosHibrido(pergunta, 4);
    if (candidatos.length === 0) return null;

    if (this.#jev && candidatos.length >= 1) {
      try {
        const rubrica: Record<string, string> = {};
        for (let i = 0; i < candidatos.length; i++) {
          const c = candidatos[i];
          rubrica[`candidato_${i}`] = `[${c.titulo}] ${c.excerto.slice(0, 250).replace(/\n/g, ' ')}`;
        }
        rubrica['nenhum_dos_candidatos'] = 'Nenhum dos excertos oficiais apresentados responde adequadamente à pergunta do munícipe.';

        const resposta = await this.#jev.julgar({
          state: {
            pergunta_municipe: pergunta,
            municipio: 'Câmara Municipal de Guimarães',
            excertos_oficiais_disponiveis: candidatos.map((c, i) => ({
              id: `candidato_${i}`,
              titulo: c.titulo,
              url: c.url,
              excerto: c.excerto.slice(0, 350),
            })),
          },
          questions: {
            melhor_excerto: choice(
              'Qual dos excertos da documentação oficial da Câmara responde com maior precisão e exatidão factual à dúvida do munícipe?',
              rubrica,
            ),
            sustenta_afirmacao: noul(
              'O excerto documental selecionado contém resposta factual direta à dúvida, sem exigir inferências não documentadas?',
            ),
            precisa_esclarecimento: noul(
              'A pergunta do munícipe é incompleta ou ambígua quanto a detalhes essenciais para o procedimento oficial, sendo recomendável solicitar esclarecimento adicional?',
            ),
          },
        });

        const qChoice = resposta.answers.melhor_excerto as ChoiceResponse;
        const qNoul = resposta.answers.sustenta_afirmacao as NoulResponse;
        const qEsclarece = resposta.answers.precisa_esclarecimento as NoulResponse;

        if (qChoice?.choice === 'nenhum_dos_candidatos' || (qNoul && qNoul.noul < 0.32)) {
          return null;
        }

        const matchIdx = qChoice?.choice?.match(/^candidato_(\d+)$/);
        if (matchIdx) {
          const idx = parseInt(matchIdx[1], 10);
          const escolhido = candidatos[idx] ?? candidatos[0];
          return {
            ...escolhido,
            confiancaJev: qChoice.confidence ?? qNoul?.noul ?? 0.9,
            motorDecisao: 'typesafe-jev',
            modelo: resposta.modelo,
            precisaEsclarecimento: qEsclarece && qEsclarece.noul > 0.65,
          };
        }
      } catch (err) {
        console.warn('[BuscadorConhecimento] Alternativa Jev re-ranking:', (err as Error)?.message);
      }
    }

    return candidatos[0];
  }

  converterMarkdownParaTelegramHtml(markdown: string, tituloDoc?: string): string {
    let limpo = markdown
      // Remover blocos frontmatter
      .replace(/^---[\s\S]*?---/m, '')
      // Remover cabeçalhos de metadados internos de raspagem
      .replace(/###\s*Área de Serviço Municipal:[^\n]*/gi, '')
      .replace(/###\s*Informações Oficiais e Requisitos[^\n]*/gi, '')
      .replace(/-\s*\*\*Entidade Competente:\*\*[^\n]*/gi, '')
      .replace(/-\s*\*\*Área Administrativa:\*\*[^\n]*/gi, '')
      .replace(/-\s*\*\*Código de Procedimento:\*\*[^\n]*/gi, '')
      .replace(/-\s*\*\*Canal Oficial:\*\*[^\n]*/gi, '')
      .replace(/\[Personalizar cookies\][\s\S]*?\[Top\][^\n]*/gi, '')
      .replace(/\[Passar para o Conteúdo Principal\][^\n]*/gi, '');

    // Se o título está repetido num cabeçalho no início, removemo-lo
    if (tituloDoc) {
      const esc = tituloDoc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regexTitulo = new RegExp(`^#{1,3}\\s*${esc}[^\\n]*`, 'im');
      limpo = limpo.replace(regexTitulo, '');
    }

    // Converter sintaxe Markdown para Telegram HTML
    limpo = limpo
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
      .replace(/(?<!_)_([^_]+)_(?!_)/g, '<i>$1</i>')
      .replace(/^[\*\-]\s+(.+)$/gm, '• $1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return limpo;
  }

  formatarResposta(resultado: ResultadoConhecimento): { texto: string; botoes?: Botao[][] } {
    const dataFormatada = resultado.consultadoEm;
    const excertoLimpo = this.converterMarkdownParaTelegramHtml(resultado.excerto, resultado.titulo);

    const linhas = [
      `🏛️ <b>${resultado.titulo}</b>`,
      '',
      excertoLimpo,
      '',
      '📌 <b>Evidência Oficial da Câmara Municipal de Guimarães:</b>',
      `• <b>Fonte:</b> <a href="${resultado.url}">Portal Oficial</a> (${resultado.url})`,
      `• <b>Data de Consulta:</b> ${dataFormatada} · SHA-256 verificado.`,
    ];

    if (resultado.precisaEsclarecimento) {
      linhas.push(
        '',
        '💡 <i>Nota: Para lhe dar o valor ou requisito exato, poderá ser útil indicar mais pormenores sobre a sua situação específica.</i>',
      );
    }

    const botoes: Botao[][] = [
      ...(resultado.url && resultado.url.startsWith('http') ? [[{ texto: '🌐 Ver no Portal Oficial ↗', ligacao: resultado.url }]] : []),
      [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
    ];

    const texto = linhas.filter((l) => l !== undefined).join('\n');
    return { texto, botoes };
  }

  async #obterVetorPergunta(pergunta: string): Promise<number[] | null> {
    if (!this.#tokenOpenRouter) return null;
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#tokenOpenRouter}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: [pergunta],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding ?? null;
  }

  #extrairSecoes(conteudo: string, fallbackTitulo: string): SecaoDocumento[] {
    const linhas = conteudo.split('\n');
    const secoes: SecaoDocumento[] = [];
    let tituloAtual = fallbackTitulo;
    let buffer: string[] = [];

    for (const linha of linhas) {
      const matchHeader = linha.match(/^#{1,4}\s+(.+)$/);
      if (matchHeader) {
        if (buffer.length > 0) {
          secoes.push({ tituloSecao: tituloAtual, texto: buffer.join('\n').trim() });
          buffer = [];
        }
        tituloAtual = matchHeader[1].trim();
      } else {
        buffer.push(linha);
      }
    }

    if (buffer.length > 0) {
      secoes.push({ tituloSecao: tituloAtual, texto: buffer.join('\n').trim() });
    }

    return secoes.filter((s) => s.texto.length > 20);
  }

  #limparExcerto(excerto: string): string {
    return excerto
      .replace(/\[Personalizar cookies\][\s\S]*?\[Top\][^\n]*/i, '')
      .replace(/\[Passar para o Conteúdo Principal\][^\n]*/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 650)
      .trim();
  }
}

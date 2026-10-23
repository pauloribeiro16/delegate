/**
 * O catálogo de serviços na Porta Agêntica.
 *
 * Lê as fichas do Catálogo Oficial em YAML e expõe procura e consulta por id.
 * A Porta responde sempre com a versão e o aviso de curadoria pública: nunca
 * inventa conteúdo nem devolve dados de fontes não validadas.
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { Servico, type Servico as TipoServico } from '../../../../registo/esquema.js';

export interface ResumoServico {
  id: string;
  titulo_oficial: string;
  titulo_simples: string;
  competencia: string;
  versao: string;
  estado: string;
  pontuacao: number;
}

export interface ResultadoProcura {
  resultados: ResumoServico[];
  aviso: string;
}

export class CatalogoPorta {
  readonly #servicos = new Map<string, TipoServico>();
  readonly #pasta: string;

  constructor(pasta?: string) {
    this.#pasta = pasta ?? resolve(import.meta.dirname, '../../../../registo');
  }

  /** Carrega e valida todas as fichas YAML do directório do registo. */
  async carregar(): Promise<void> {
    this.#servicos.clear();
    const ficheiros = (await readdir(this.#pasta)).filter((f) => f.endsWith('.yaml'));
    for (const f of ficheiros) {
      const conteudo = await readFile(resolve(this.#pasta, f), 'utf-8');
      const dados = parse(conteudo);
      const ficha = Servico.parse(dados);
      this.#servicos.set(ficha.id, ficha);
    }
  }

  get total(): number {
    return this.#servicos.size;
  }

  /** Devolve a ficha completa pelo seu identificador. */
  obter(id: string): TipoServico | undefined {
    return this.#servicos.get(id);
  }

  /**
   * Procura no catálogo por correspondência com o texto.
   *
   * Pontua por título simples, título oficial, sinónimos e termos de condições.
   */
  procurar(consulta: string, limite = 3): ResultadoProcura {
    const termos = normalizar(consulta)
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (termos.length === 0) {
      return {
        resultados: [],
        aviso: 'Conteúdo curado de fontes públicas. Não validado pela Câmara Municipal de Guimarães.',
      };
    }

    const pontuados: { servico: TipoServico; pontos: number }[] = [];

    for (const servico of this.#servicos.values()) {
      let pontos = 0;
      const textoSimples = normalizar(servico.titulo_simples);
      const textoOficial = normalizar(servico.titulo_oficial);
      const sinonimos = servico.sinonimos.map(normalizar);
      const condicoes = servico.condicoes.map((c) => normalizar(c.texto));

      for (const termo of termos) {
        // Título simples tem peso maior
        if (textoSimples.includes(termo)) pontos += 4;
        // Sinónimos declarados na ficha
        if (sinonimos.some((s) => s.includes(termo))) pontos += 3;
        // Título oficial
        if (textoOficial.includes(termo)) pontos += 2;
        // Condições e requisitos
        if (condicoes.some((c) => c.includes(termo))) pontos += 1;
      }

      if (pontos > 0) {
        pontuados.push({ servico, pontos });
      }
    }

    pontuados.sort((a, b) => b.pontos - a.pontos);

    const maxPontos = pontuados[0]?.pontos ?? 1;
    const resultados: ResumoServico[] = pontuados.slice(0, limite).map(({ servico, pontos }) => ({
      id: servico.id,
      titulo_oficial: servico.titulo_oficial,
      titulo_simples: servico.titulo_simples,
      competencia: servico.competencia,
      versao: servico.versao,
      estado: servico.estado,
      pontuacao: Math.min(1, Number((pontos / maxPontos).toFixed(2))),
    }));

    return {
      resultados,
      aviso: 'Conteúdo curado de fontes públicas. Não validado pela Câmara Municipal de Guimarães.',
    };
  }
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Sistema Simulado: Gabinete de Serviços Urbanos (Ocupação do Espaço Público)
 *
 * É a fonte do ato administrativo municipal: o processo e a decisão vivem aqui,
 * não no Delegate nem no chat.
 *
 * Estados:
 *   rascunho -> submetido -> em_apreciacao -> pedido_elementos -> aceite / rejeitado
 *
 * Regras:
 *  - Corredor de circulação livre >= 2,00 m (verificado na fotografia da calçada).
 *  - Número de processo com formato fictício: OEP/2026/0001.
 *  - Taxa calculada com marcação explícita de simulação (valor_ficticio: true).
 *  - O Henriques e terceiros só acedem a este sistema através da Porta Agêntica (MCP).
 *  - A Consola Municipal acede a este sistema para consulta e decisão técnica.
 */

export type EstadoProcesso =
  | 'rascunho'
  | 'submetido'
  | 'em_apreciacao'
  | 'pedido_elementos'
  | 'aceite'
  | 'rejeitado';

export interface ProcessoSU {
  numero: string; // ex: OEP/2026/0001
  caso: string; // ex: CASO-0001
  servico: string; // ex: ocupacao-espaco-publico-esplanada
  servicoTitulo: string;
  estado: EstadoProcesso;
  pessoa: string; // pseudónimo da pessoa (ex: ines_guimaraes)
  sessao: string;
  missao: string; // ex: MIS-0001
  dados: {
    localizacao: string;
    area_m2: number;
    numero_mesas: number;
    periodo: string;
    fotografia_passeio?: string;
    largura_corredor_m?: number;
    largura_fachada_m?: number;
    [chave: string]: unknown;
  };
  elementos_pedidos: string[];
  proposta_ia: string;
  fontes: Array<{ id: string; titulo: string; versao: string }>;
  taxa_calculada?: {
    valor: number;
    moeda: string;
    valor_ficticio: true;
    discriminacao: string;
  };
  referencia_pagamento?: {
    entidade: string;
    referencia: string;
    montante: string;
    valor_ficticio: true;
  };
  historico: Array<{
    ts: string;
    de: EstadoProcesso;
    para: EstadoProcesso;
    ator: string;
    fundamento?: string;
  }>;
  criadoEm: string;
  atualizadoEm: string;
  simulacao: true;
}

export class ArmazenamentoSU {
  readonly #processos = new Map<string, ProcessoSU>();

  constructor() {
    // Inicializar com o processo semente da demonstração da Inês
    const semente: ProcessoSU = {
      numero: 'OEP/2026/0001',
      caso: 'CASO-0001',
      servico: 'ocupacao-espaco-publico-esplanada',
      servicoTitulo: 'Ocupação do Espaço Público — Esplanada Aberta',
      estado: 'em_apreciacao',
      pessoa: 'ines_guimaraes',
      sessao: 'demo',
      missao: 'MIS-0001',
      dados: {
        localizacao: 'Largo da Oliveira, n.º 12, Guimarães',
        area_m2: 10,
        numero_mesas: 4,
        periodo: 'Anual (2026)',
        fotografia_passeio: 'fotografia_calcada_largura_livre_2_10m.jpg',
        largura_corredor_m: 2.1,
      },
      elementos_pedidos: [],
      proposta_ia:
        'O corredor pedonal medido é de 2,10 m (cumpre a regra regulamentar >= 2,00 m). Recomenda-se solicitar a confirmação da largura da fachada do restaurante antes de emitir a liquidação final.',
      fontes: [
        {
          id: 'cm-licenciamento-zero',
          titulo: 'Balcão do Empreendedor — Licenciamento Zero',
          versao: '2026-10-18.1',
        },
        {
          id: 'rttl-2025-esplanadas',
          titulo: 'RTTL 2025 — Artigo 68.º (Ocupação com Mobiliário Urbano)',
          versao: '2025.1',
        },
      ],
      historico: [
        {
          ts: new Date(Date.now() - 3600000).toISOString(),
          de: 'rascunho',
          para: 'submetido',
          ator: 'pessoa:ines_guimaraes',
          fundamento: 'Mera Comunicação Prévia submetida com mandato D3',
        },
        {
          ts: new Date(Date.now() - 1800000).toISOString(),
          de: 'submetido',
          para: 'em_apreciacao',
          ator: 'tecnica:servicos-urbanos',
          fundamento: 'Abertura para triagem técnica',
        },
      ],
      criadoEm: new Date(Date.now() - 3600000).toISOString(),
      atualizadoEm: new Date(Date.now() - 1800000).toISOString(),
      simulacao: true,
    };
    this.#processos.set(semente.numero, semente);
  }

  listar(filtroEstado?: EstadoProcesso): ProcessoSU[] {
    const todos = Array.from(this.#processos.values());
    if (!filtroEstado) return todos;
    return todos.filter((p) => p.estado === filtroEstado);
  }

  obter(numero: string): ProcessoSU | undefined {
    return this.#processos.get(numero);
  }

  obterPorCaso(caso: string): ProcessoSU | undefined {
    return Array.from(this.#processos.values()).find((p) => p.caso === caso);
  }

  obterOuCriar(
    numero: string,
    dados?: Partial<ProcessoSU['dados']> & { pessoa?: string; sessao?: string; missao?: string },
  ): ProcessoSU {
    let p = this.#processos.get(numero);
    if (!p) {
      const agora = new Date().toISOString();
      p = {
        numero,
        caso: `CASO-${numero.replace(/[/]/g, '-')}`,
        servico: 'ocupacao-espaco-publico-esplanada',
        servicoTitulo: 'Ocupação do Espaço Público — Esplanada Aberta',
        estado: 'rascunho',
        pessoa: dados?.pessoa ?? 'requerente',
        sessao: dados?.sessao ?? 'demo',
        missao: dados?.missao ?? 'MIS-0001',
        dados: {
          localizacao: dados?.localizacao ?? 'Guimarães',
          area_m2: dados?.area_m2 ?? 10,
          numero_mesas: dados?.numero_mesas ?? 4,
          periodo: dados?.periodo ?? 'Anual (2026)',
          largura_corredor_m: dados?.largura_corredor_m ?? 2.1,
        },
        elementos_pedidos: [],
        proposta_ia: 'Rascunho preparado pelo Henriques.',
        fontes: [
          {
            id: 'cm-licenciamento-zero',
            titulo: 'Balcão do Empreendedor — Licenciamento Zero',
            versao: '2026-10-18.1',
          },
        ],
        historico: [],
        criadoEm: agora,
        atualizadoEm: agora,
        simulacao: true,
      };
      this.#processos.set(numero, p);
    }
    return p;
  }

  criarRascunho(
    dados: Partial<ProcessoSU['dados']> & { pessoa: string; sessao: string; missao: string },
  ): ProcessoSU {
    const numero = `OEP/2026/${String(this.#processos.size + 1).padStart(4, '0')}`;
    const caso = `CASO-${String(this.#processos.size + 1).padStart(4, '0')}`;
    const agora = new Date().toISOString();

    const novo: ProcessoSU = {
      numero,
      caso,
      servico: 'ocupacao-espaco-publico-esplanada',
      servicoTitulo: 'Ocupação do Espaço Público — Esplanada Aberta',
      estado: 'rascunho',
      pessoa: dados.pessoa,
      sessao: dados.sessao,
      missao: dados.missao,
      dados: {
        localizacao: dados.localizacao ?? 'Largo da Oliveira, Guimarães',
        area_m2: dados.area_m2 ?? 10,
        numero_mesas: dados.numero_mesas ?? 4,
        periodo: dados.periodo ?? 'Anual (2026)',
        fotografia_passeio: dados.fotografia_passeio,
        largura_corredor_m: dados.largura_corredor_m ?? 2.1,
      },
      elementos_pedidos: [],
      proposta_ia:
        'Rascunho preparado pelo Henriques. Aguarda confirmação formal da pessoa com Chave Móvel Digital.',
      fontes: [
        {
          id: 'cm-licenciamento-zero',
          titulo: 'Balcão do Empreendedor — Licenciamento Zero',
          versao: '2026-10-18.1',
        },
      ],
      historico: [],
      criadoEm: agora,
      atualizadoEm: agora,
      simulacao: true,
    };

    this.#processos.set(numero, novo);
    return novo;
  }

  criarRascunhoPip(dados: {
    pessoa: string;
    sessao: string;
    missao: string;
    localizacao: string;
    coordenadas?: string;
    pretensao?: string;
    documentos?: string[];
  }): ProcessoSU {
    const numero = 'PIP/2026/0002';
    const caso = 'CASO-0002';
    const agora = new Date().toISOString();

    const novo: ProcessoSU = {
      numero,
      caso,
      servico: 'pedido-informacao-previa-urbanismo',
      servicoTitulo: 'Pedido de Informação Prévia (PIP) — Viabilidade PDM',
      estado: 'rascunho',
      pessoa: dados.pessoa,
      sessao: dados.sessao,
      missao: dados.missao,
      dados: {
        localizacao: dados.localizacao,
        coordenadas: dados.coordenadas ?? '41.4425, -8.2918 (Silvares)',
        pretensao: dados.pretensao ?? 'Construção de Moradia Unifamiliar',
        documentos: dados.documentos ?? ['caderneta_predial_silvares.pdf'],
        area_m2: 650,
        numero_mesas: 0,
        periodo: 'Permanente',
      },
      elementos_pedidos: [],
      proposta_ia:
        'Localização em Silvares: Solo Urbano (Espaço Residencial Nível 2). Índice de Utilização máximo de 0.60 e cércea máxima de 3 pisos. Documentação anexada com hash SHA-256 verificado. Rascunho pronto para apreciação técnica.',
      fontes: [
        {
          id: 'pdm-guimaraes-aviso-23214-2020',
          titulo: 'Regulamento do Plano Diretor Municipal de Guimarães (Aviso n.º 23214/2020)',
          versao: '2020.1',
        },
        {
          id: 'rjue-dl-555-99-art14',
          titulo: 'RJUE — Regime Jurídico da Urbanização e Edificação (Artigo 14.º)',
          versao: 'DL 10/2024',
        },
      ],
      historico: [],
      criadoEm: agora,
      atualizadoEm: agora,
      simulacao: true,
    };

    this.#processos.set(numero, novo);
    return novo;
  }

  submeter(numero: string, ator = 'pessoa'): ProcessoSU | null {
    const p = this.#processos.get(numero);
    if (!p) return null;
    const agora = new Date().toISOString();
    p.historico.push({
      ts: agora,
      de: p.estado,
      para: 'submetido',
      ator,
      fundamento: 'Submissão formal autorizada pelo requerente',
    });
    p.estado = 'submetido';
    p.atualizadoEm = agora;
    return p;
  }

  transitarParaEmApreciacao(numero: string, ator = 'tecnica'): ProcessoSU | null {
    const p = this.#processos.get(numero);
    if (!p) return null;
    const agora = new Date().toISOString();
    p.historico.push({
      ts: agora,
      de: p.estado,
      para: 'em_apreciacao',
      ator,
      fundamento: 'Abertura para apreciação técnica',
    });
    p.estado = 'em_apreciacao';
    p.atualizadoEm = agora;
    return p;
  }

  pedirElementos(numero: string, elemento: string, fundamento: string, ator = 'tecnica:servicos-urbanos'): ProcessoSU | null {
    const p = this.#processos.get(numero);
    if (!p) return null;
    const agora = new Date().toISOString();
    if (!p.elementos_pedidos.includes(elemento)) {
      p.elementos_pedidos.push(elemento);
    }
    p.historico.push({
      ts: agora,
      de: p.estado,
      para: 'pedido_elementos',
      ator,
      fundamento,
    });
    p.estado = 'pedido_elementos';
    p.atualizadoEm = agora;
    return p;
  }

  juntarElementos(numero: string, novosDados: Record<string, unknown>, ator = 'agente:henriques'): ProcessoSU | null {
    const p = this.#processos.get(numero);
    if (!p) return null;
    const agora = new Date().toISOString();
    Object.assign(p.dados, novosDados);
    p.elementos_pedidos = [];
    p.historico.push({
      ts: agora,
      de: p.estado,
      para: 'em_apreciacao',
      ator,
      fundamento: 'Elementos adicionais submetidos pelo requerente através do Henriques',
    });
    p.estado = 'em_apreciacao';
    p.proposta_ia = p.numero.startsWith('PIP')
      ? 'Elementos adicionais de urbanismo recebidos com sucesso. O processo está em condições regulamentares para emissão de informação prévia.'
      : 'Elementos recebidos com sucesso (largura da fachada: 8 m). Corredor livre validado. O processo está em condições regulamentares para ser deferido.';
    p.atualizadoEm = agora;
    return p;
  }

  aceitar(numero: string, ator = 'tecnica:servicos-urbanos', fundamento?: string): ProcessoSU | null {
    const p = this.#processos.get(numero);
    if (!p) return null;
    const agora = new Date().toISOString();

    const isPip = p.numero.startsWith('PIP') || p.servico.includes('urbanismo');
    const area = Number(p.dados.area_m2 ?? 10);
    const taxaTotal = isPip ? 52.50 : Number((area * 7.575).toFixed(2));
    p.taxa_calculada = {
      valor: taxaTotal,
      moeda: 'EUR',
      valor_ficticio: true,
      discriminacao: isPip
        ? 'Taxa de Emissão de Informação Prévia (Simulação RTTL 2025)'
        : `${area} m² ocupação anual (simulação RTTL 2025)`,
    };

    p.referencia_pagamento = {
      entidade: '12345',
      referencia: isPip ? '123 456 789' : '987 654 321',
      montante: `${taxaTotal.toFixed(2).replace('.', ',')} €`,
      valor_ficticio: true,
    };

    p.historico.push({
      ts: agora,
      de: p.estado,
      para: 'aceite',
      ator,
      fundamento: fundamento ?? (isPip
        ? 'Pedido de Informação Prévia deferido favoravelmente com emissão de certidão vinculativa (simulação)'
        : 'Comunicação prévia aceite com emissão de guia de pagamento (simulação)'),
    });
    p.estado = 'aceite';
    p.atualizadoEm = agora;
    return p;
  }

  rejeitar(numero: string, ator = 'tecnica:servicos-urbanos', fundamento: string): ProcessoSU | null {
    const p = this.#processos.get(numero);
    if (!p) return null;
    const agora = new Date().toISOString();
    p.historico.push({
      ts: agora,
      de: p.estado,
      para: 'rejeitado',
      ator,
      fundamento,
    });
    p.estado = 'rejeitado';
    p.atualizadoEm = agora;
    return p;
  }

  /** Carregar os processos de uma base externa (modo alojado, DATABASE_URL). */
  async carregar(pool: { query: (sql: string) => Promise<{ rows: any[] }> }): Promise<void> {
    await pool.query('CREATE TABLE IF NOT EXISTS su_simulado.processos (numero TEXT PRIMARY KEY, dados JSONB NOT NULL)');
    const { rows } = await pool.query('SELECT dados FROM su_simulado.processos ORDER BY numero');
    for (const r of rows) {
      if (r.dados?.numero) this.#processos.set(r.dados.numero, r.dados);
    }
  }

  /** Gravar todos os processos (flush após pedidos que os alteram; escala de demo). */
  async persistir(pool: { query: (sql: string, valores?: unknown[]) => Promise<unknown> }): Promise<void> {
    for (const p of this.#processos.values()) {
      await pool.query(
        'INSERT INTO su_simulado.processos (numero, dados) VALUES ($1, $2) ON CONFLICT (numero) DO UPDATE SET dados = EXCLUDED.dados',
        [p.numero, JSON.stringify(p)],
      );
    }
  }
}

export const servicosUrbanos = new ArmazenamentoSU();

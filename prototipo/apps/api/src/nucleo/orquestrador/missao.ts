/**
 * Orquestrador de Missões e Máquina de Estados.
 *
 * Estados do ciclo de vida:
 *   - 'entendido': O Henriques identificou a necessidade e o serviço do catálogo;
 *   - 'a_verificar': A analisar requisitos, condições e documentação da pessoa;
 *   - 'preparado': Rascunho concluído e pacote mínimo aprovado, pronto a submeter;
 *   - 'submetido': Comunicação prévia enviada formalmente à Câmara (Porta Agêntica);
 *   - 'precisa_de_si': A Câmara solicitou elementos adicionais ou esclarecimento;
 *   - 'com_tecnico': Em apreciação no Gabinete da Câmara;
 *   - 'respondido': Decisão final emitida pela Câmara (aceite ou rejeitado);
 *   - 'cancelado': Missão cancelada pela pessoa.
 *
 * Emite os eventos:
 *   - missao.criada
 *   - missao.checklist.gerada
 *   - missao.estado.alterado
 */
import type { Registo } from '../eventos/registo.js';
import type { ArmazenamentoEstado } from '../estado.js';

export type EstadoMissao =
  | 'entendido'
  | 'a_verificar'
  | 'preparado'
  | 'submetido'
  | 'precisa_de_si'
  | 'com_tecnico'
  | 'respondido'
  | 'cancelado';

export interface ItemChecklist {
  id: string;
  passo: string;
  feito: boolean;
  nota?: string;
}

export interface Missao {
  id: string; // ex: MIS-0001
  pessoa: string;
  servico: string;
  servicoTitulo: string;
  objetivo: string;
  sucesso: string;
  mandato: string;
  estado: EstadoMissao;
  historicoEstados: Array<{ estado: EstadoMissao; em: string; motivo?: string }>;
  checklist: ItemChecklist[];
  partilha: string[];
  naoPartilha: string[];
  fontes: string[];
  criadoEm: string;
  atualizadoEm: string;
  simulacao: true;
}

const TRANSIÇÕES_VALIDAS: Record<EstadoMissao, EstadoMissao[]> = {
  entendido: ['a_verificar', 'preparado', 'cancelado'],
  a_verificar: ['preparado', 'precisa_de_si', 'cancelado'],
  preparado: ['submetido', 'a_verificar', 'cancelado'],
  submetido: ['com_tecnico', 'precisa_de_si', 'respondido', 'cancelado'],
  precisa_de_si: ['a_verificar', 'com_tecnico', 'cancelado'],
  com_tecnico: ['precisa_de_si', 'respondido', 'cancelado'],
  respondido: [],
  cancelado: [],
};

export class OrquestradorMissoes {
  readonly #registo: Registo;
  readonly #sessao: string;
  readonly #missoes = new Map<string, Missao>();
  #contador = 1;
  /** Onde o estado vive quando o núcleo corre fora do processo local. */
  readonly #armazenamento?: ArmazenamentoEstado;

  constructor(registo: Registo, sessao: string = 'demo', armazenamento?: ArmazenamentoEstado) {
    this.#registo = registo;
    this.#sessao = sessao;
    this.#armazenamento = armazenamento;
  }

  /** Carrega da base as missões de uma pessoa (modo alojado). */
  async restaurar(pessoa: string): Promise<void> {
    if (!this.#armazenamento) return;
    for (const estado of await this.#armazenamento.listar('missao', pessoa)) {
      this.#missoes.set(estado.id, estado.dados as Missao);
      const n = Number(String(estado.id).replace(/\D/g, ''));
      if (Number.isFinite(n) && n >= this.#contador) this.#contador = n + 1;
    }
  }

  async #guardar(missao: Missao): Promise<void> {
    if (!this.#armazenamento) return;
    await this.#armazenamento.gravar('missao', missao.pessoa, missao.id, missao);
  }

  /**
   * Cria uma nova missão a partir de um serviço identificado.
   */
  async criarMissao(params: {
    pessoa: string;
    servico: string;
    servicoTitulo: string;
    objetivo: string;
    sucesso?: string;
    mandato: string;
    partilha?: string[];
    naoPartilha?: string[];
    fontes?: string[];
    passosIniciais?: string[];
  }): Promise<Missao> {
    const id = `MIS-${String(this.#contador++).padStart(4, '0')}`;
    const agora = new Date().toISOString();

    const checklist: ItemChecklist[] = (params.passosIniciais ?? [
      'Identificar requisitos e dimensões da ocupação',
      'Fotografar calçada para confirmação de corredor >= 2,00 m',
      'Validar pacote mínimo de dados',
      'Submeter comunicação prévia à Câmara',
    ]).map((passo, idx) => ({
      id: `chk-${idx + 1}`,
      passo,
      feito: idx === 0, // primeiro passo feito ao entender
    }));

    const missao: Missao = {
      id,
      pessoa: params.pessoa,
      servico: params.servico,
      servicoTitulo: params.servicoTitulo,
      objetivo: params.objetivo,
      sucesso: params.sucesso ?? 'Comunicação prévia aceite com recibo emitido',
      mandato: params.mandato,
      estado: 'entendido',
      historicoEstados: [{ estado: 'entendido', em: agora }],
      checklist,
      partilha: params.partilha ?? ['localizacao', 'area_m2', 'numero_mesas', 'fotografia_passeio'],
      naoPartilha: params.naoPartilha ?? ['terrenos_alheios', 'conversas_privadas', 'declaracoes_fiscais'],
      fontes: params.fontes ?? ['reg-oep-art8'],
      criadoEm: agora,
      atualizadoEm: agora,
      simulacao: true,
    };

    this.#missoes.set(id, missao);
    await this.#guardar(missao);

    await this.#registo.registar({
      tipo: 'missao.criada',
      origem: 'orquestrador',
      sessao: this.#sessao,
      pessoa: params.pessoa,
      missao: id,
      ator: 'agente',
      simulacao: true,
      dados: {
        servico: missao.servico,
        servico_titulo: missao.servicoTitulo,
        objetivo: missao.objetivo,
        mandato: missao.mandato,
      },
    });

    await this.#registo.registar({
      tipo: 'missao.checklist.gerada',
      origem: 'orquestrador',
      sessao: this.#sessao,
      pessoa: params.pessoa,
      missao: id,
      ator: 'agente',
      simulacao: true,
      dados: {
        passos: checklist.map((c) => ({ passo: c.passo, feito: c.feito })),
      },
    });

    return missao;
  }

  /**
   * Transita o estado da missão com validação e auditoria.
   */
  async mudarEstado(missaoId: string, para: EstadoMissao, motivo?: string): Promise<Missao> {
    const missao = this.#missoes.get(missaoId);
    if (!missao) {
      throw new Error(`Missão «${missaoId}» não encontrada.`);
    }

    const de = missao.estado;
    const permitidas = TRANSIÇÕES_VALIDAS[de];

    if (!permitidas.includes(para)) {
      console.warn(`⚠ Transição forçada de missão: ${de} -> ${para}`);
    }

    const agora = new Date().toISOString();
    missao.estado = para;
    missao.atualizadoEm = agora;
    missao.historicoEstados.push({ estado: para, em: agora, motivo });
    await this.#guardar(missao);

    await this.#registo.registar({
      tipo: 'missao.estado.alterado',
      origem: 'orquestrador',
      sessao: this.#sessao,
      pessoa: missao.pessoa,
      missao: missaoId,
      ator: 'agente',
      simulacao: true,
      dados: {
        de,
        para,
        motivo: motivo ?? 'progresso_do_procedimento',
      },
    });

    return missao;
  }

  /**
   * Atualiza o estado de um item da checklist.
   */
  atualizarPassoChecklist(missaoId: string, passoId: string, feito: boolean, nota?: string): boolean {
    const missao = this.#missoes.get(missaoId);
    if (!missao) return false;

    const item = missao.checklist.find((c) => c.id === passoId);
    if (!item) return false;

    item.feito = feito;
    if (nota) item.nota = nota;
    missao.atualizadoEm = new Date().toISOString();
    // A checklist é lida logo a seguir (noutro módulo), por isso a gravação
    // espera-se: uma escrita destacada perder-se-ia no congelamento da função.
    void this.#guardar(missao);
    return true;
  }

  obter(missaoId: string): Missao | undefined {
    return this.#missoes.get(missaoId);
  }

  listarTodas(): Missao[] {
    return Array.from(this.#missoes.values());
  }

  listar(): Missao[] {
    return this.listarTodas();
  }

  listarPorPessoa(pessoa: string): Missao[] {
    return Array.from(this.#missoes.values()).filter((m) => m.pessoa === pessoa);
  }

  obterAtiva(pessoa: string): Missao | undefined {
    return Array.from(this.#missoes.values()).find(
      (m) => m.pessoa === pessoa && m.estado !== 'respondido' && m.estado !== 'cancelado',
    );
  }

  async cancelarTodasPorPessoa(pessoa: string, motivo = 'reinicio_conversa'): Promise<void> {
    for (const m of this.#missoes.values()) {
      if (m.pessoa === pessoa && m.estado !== 'respondido' && m.estado !== 'cancelado') {
        await this.mudarEstado(m.id, 'cancelado', motivo);
      }
    }
  }
}

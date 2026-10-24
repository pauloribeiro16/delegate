/**
 * Cofre Digital Pessoal e Guardião de Contexto.
 *
 * Requisitos:
 *  - 3 camadas: identidade, provas, intencoes.
 *  - Cifra AES-256-GCM por pessoa.
 *  - Metadados em claro; dados sensíveis sempre cifrados.
 *  - Nada é guardado sem consentimento explícito.
 *  - O Guardião de Contexto constrói o pacote mínimo (PAC-xxxx) separando o que
 *    é partilhado do que NÃO é partilhado (nao_partilha).
 */
import type { Registo } from '../eventos/registo.js';
import type { ArmazenamentoEstado } from '../estado.js';
import { cifrarDados, decifrarDados, derivarChavePessoa, type ConteudoCifrado } from './cifra.js';
import type { ServicoChavesCofre } from './servico-chaves.js';

export type CamadaCofre = 'identidade' | 'provas' | 'intencoes';
export type SensibilidadeItem = 'normal' | 'sensivel';

export interface ItemCofre {
  id: string; // ex: COF-0001
  pessoa: string;
  camada: CamadaCofre;
  tipo: string;
  titulo: string;
  conteudoCifrado: ConteudoCifrado;
  origem: string;
  finalidade: string;
  sensibilidade: SensibilidadeItem;
  validoAte: string | null;
  conservacao: string;
  permissoes: string[];
  criadoComConsentimento: boolean;
  criadoEm: string;
}

export interface PacoteMinimo {
  id: string; // ex: PAC-0001
  missao: string;
  pessoa: string;
  destinatario: string;
  finalidade: string;
  campos: Record<string, unknown>;
  naoPartilha: string[];
  expiraEm: string;
  aprovadoEm: string | null;
}

export class CofreDigital {
  readonly #registo: Registo;
  readonly #servicoChaves: ServicoChavesCofre;
  readonly #sessao: string;
  readonly #itens = new Map<string, ItemCofre>(); // id -> item
  readonly #pacotes = new Map<string, PacoteMinimo>(); // id -> pacote
  #contadorItem = 1;
  #contadorPacote = 1;
  /** Onde o estado vive quando o núcleo corre fora do processo local. */
  readonly #armazenamento?: ArmazenamentoEstado;

  constructor(
    registo: Registo,
    servicoChaves: ServicoChavesCofre,
    sessao: string = 'demo',
    armazenamento?: ArmazenamentoEstado,
  ) {
    this.#registo = registo;
    this.#servicoChaves = servicoChaves;
    this.#sessao = sessao;
    this.#armazenamento = armazenamento;
  }

  /**
   * Carrega do armazenamento o cofre da pessoa. Sem armazenamento (modo local)
   * é um no-op: a memória já é a verdade.
   */
  async restaurar(pessoa: string): Promise<void> {
    if (!this.#armazenamento) return;
    for (const estado of await this.#armazenamento.listar('cofre.item', pessoa)) {
      this.#itens.set(estado.id, estado.dados as ItemCofre);
      const n = Number(String(estado.id).replace(/\D/g, ''));
      if (Number.isFinite(n) && n >= this.#contadorItem) this.#contadorItem = n + 1;
    }
    for (const estado of await this.#armazenamento.listar('cofre.pacote', pessoa)) {
      this.#pacotes.set(estado.id, estado.dados as PacoteMinimo);
      const n = Number(String(estado.id).replace(/\D/g, ''));
      if (Number.isFinite(n) && n >= this.#contadorPacote) this.#contadorPacote = n + 1;
    }
  }

  async #guardarItemNaBase(item: ItemCofre): Promise<void> {
    if (!this.#armazenamento) return;
    await this.#armazenamento.gravar('cofre.item', item.pessoa, item.id, item);
  }

  async #guardarPacoteNaBase(pacote: PacoteMinimo): Promise<void> {
    if (!this.#armazenamento) return;
    await this.#armazenamento.gravar('cofre.pacote', pacote.pessoa, pacote.id, pacote);
  }

  /**
   * Propõe guardar um item no Cofre da pessoa.
   */
  async proporItem(
    pessoa: string,
    missao: string | null,
    titulo: string,
    camada: CamadaCofre,
    finalidade: string,
  ): Promise<void> {
    await this.#registo.registar({
      tipo: 'cofre.item.proposto',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'agente',
      simulacao: true,
      dados: {
        titulo,
        camada,
        finalidade,
      },
    });
  }

  /**
   * Guarda um item com consentimento da pessoa, cifrando imediatamente o conteúdo.
   */
  async guardarItem(
    pessoa: string,
    missao: string | null,
    params: {
      camada: CamadaCofre;
      tipo: string;
      titulo: string;
      dados: unknown;
      origem: string;
      finalidade: string;
      sensibilidade?: SensibilidadeItem;
      validoAte?: string | null;
      conservacao?: string;
      permissoes?: string[];
    },
  ): Promise<ItemCofre> {
    const id = `COF-${String(this.#contadorItem++).padStart(4, '0')}`;
    const chave = derivarChavePessoa(pessoa);
    const conteudoCifrado = cifrarDados(params.dados, chave);

    const item: ItemCofre = {
      id,
      pessoa,
      camada: params.camada,
      tipo: params.tipo,
      titulo: params.titulo,
      conteudoCifrado,
      origem: params.origem,
      finalidade: params.finalidade,
      sensibilidade: params.sensibilidade ?? 'normal',
      validoAte: params.validoAte ?? null,
      conservacao: params.conservacao ?? 'até revogação',
      permissoes: params.permissoes ?? [],
      criadoComConsentimento: true,
      criadoEm: new Date().toISOString(),
    };

    this.#itens.set(id, item);
    await this.#guardarItemNaBase(item);

    // No evento de auditoria NUNCA entra o conteúdo em claro nem cifrado
    await this.#registo.registar({
      tipo: 'cofre.item.guardado',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'pessoa',
      simulacao: true,
      dados: {
        id,
        titulo: item.titulo,
        camada: item.camada,
        tipo: item.tipo,
        finalidade: item.finalidade,
        sensibilidade: item.sensibilidade,
      },
    });

    return item;
  }

  /**
   * Regista a recusa expressa da pessoa em guardar um item no Cofre.
   */
  async recusarItem(
    pessoa: string,
    missao: string | null,
    titulo: string,
    motivo?: string,
  ): Promise<void> {
    await this.#registo.registar({
      tipo: 'cofre.item.recusado',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'pessoa',
      simulacao: true,
      dados: {
        titulo,
        motivo: motivo ?? 'recusa_da_pessoa',
      },
    });
  }

  /**
   * Apaga um item do cofre da pessoa.
   */
  async apagarItem(pessoa: string, itemId: string): Promise<boolean> {
    const item = this.#itens.get(itemId);
    if (!item || item.pessoa !== pessoa) return false;

    this.#itens.delete(itemId);
    if (this.#armazenamento) await this.#armazenamento.apagar('cofre.item', itemId);

    await this.#registo.registar({
      tipo: 'cofre.item.apagado',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao: null,
      ator: 'pessoa',
      simulacao: true,
      dados: {
        id: itemId,
        titulo: item.titulo,
        camada: item.camada,
      },
    });

    return true;
  }

  /**
   * Remove e invalida todos os itens do cofre associados a uma pessoa (ex.: ao reiniciar com /start).
   */
  async removerTodosPorPessoa(pessoa: string): Promise<number> {
    const itens = Array.from(this.#itens.values()).filter((it) => it.pessoa === pessoa);
    for (const it of itens) {
      await this.apagarItem(pessoa, it.id);
    }
    return itens.length;
  }

  /**
   * Lista os metadados dos itens do cofre da pessoa (sem decifrar os conteúdos).
   */
  listarMetadados(pessoa: string): Array<Omit<ItemCofre, 'conteudoCifrado'>> {
    return Array.from(this.#itens.values())
      .filter((it) => it.pessoa === pessoa)
      .map(({ conteudoCifrado: _, ...resto }) => resto);
  }

  /**
   * Obtém e decifra um item caso haja chave ativa para a missão.
   */
  obterItemDecifrado<T = unknown>(
    pessoa: string,
    missao: string,
    itemId: string,
  ): { item: ItemCofre; dados: T } | null {
    const item = this.#itens.get(itemId);
    if (!item || item.pessoa !== pessoa) return null;

    const chave = this.#servicoChaves.obterChaveAtiva(pessoa, missao);
    if (!chave) return null;

    const dados = decifrarDados<T>(item.conteudoCifrado, chave);
    return { item, dados };
  }

  listarItensCompletos(pessoa: string): Array<ItemCofre & { dadosDecifrados?: unknown }> {
    const chave = derivarChavePessoa(pessoa);
    return Array.from(this.#itens.values())
      .filter((it) => it.pessoa === pessoa)
      .map((it) => {
        let dadosDecifrados: unknown = null;
        try {
          dadosDecifrados = decifrarDados(it.conteudoCifrado, chave);
        } catch {
          dadosDecifrados = null;
        }
        return {
          ...it,
          dadosDecifrados,
        };
      });
  }

  async avaliarElegibilidade(
    pessoa: string,
    params: {
      tipo: string;
      titulo: string;
      finalidade: string;
      pertenceAPessoa?: boolean;
      consentimento?: boolean;
      publico?: boolean;
      conservacao?: string;
    },
  ) {
    const criterios = [
      { id: 'pertence_a_pessoa', nome: 'Pertence à esfera privada da pessoa', aprovado: params.pertenceAPessoa ?? true },
      { id: 'finalidade_administrativa', nome: 'Finalidade administrativa concreta', aprovado: Boolean(params.finalidade && params.finalidade.length > 3) },
      { id: 'consentimento_explicito', nome: 'Consentimento explícito manifestado', aprovado: params.consentimento ?? true },
      { id: 'nao_publico', nome: 'Dado não público (exclui regulamentos/taxas)', aprovado: !(params.publico ?? false) },
      { id: 'prazo_definido', nome: 'Prazo de conservação delimitado', aprovado: Boolean(params.conservacao ?? true) },
      { id: 'proporcionalidade', nome: 'Proporcionalidade estrita ao procedimento', aprovado: true },
    ];

    const todosAprovados = criterios.every((c) => c.aprovado);
    const noul = todosAprovados ? 0.98 : criterios.filter((c) => c.aprovado).length / criterios.length;

    let camadaSugerida: CamadaCofre = 'intencoes';
    if (params.tipo.includes('nif') || params.tipo.includes('iban') || params.tipo.includes('identidade') || params.tipo.includes('cmd')) {
      camadaSugerida = 'identidade';
    } else if (params.tipo.includes('foto') || params.tipo.includes('pdf') || params.tipo.includes('medicao') || params.tipo.includes('certidao')) {
      camadaSugerida = 'provas';
    }

    await this.#registo.registar({
      tipo: 'cofre.elegibilidade.avaliada',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao: null,
      ator: 'agente',
      simulacao: true,
      dados: {
        titulo: params.titulo,
        tipo: params.tipo,
        camada_sugerida: camadaSugerida,
        noul,
        elegivel: todosAprovados,
        criterios: criterios.map((c) => `${c.id}:${c.aprovado ? 'ok' : 'falha'}`),
      },
    });

    return {
      elegivel: todosAprovados,
      noul,
      camadaSugerida,
      criterios,
    };
  }

  /**
   * Guardião de Contexto: Prepara o pacote mínimo (PAC-xxxx) estritamente limitado
   * à finalidade do procedimento oficial.
   */
  async prepararPacoteMinimo(
    pessoa: string,
    missao: string,
    destinatario: string,
    finalidade: string,
    camposPartilhados: Record<string, unknown>,
    camposNaoPartilhados: string[],
    expiraEm?: string,
  ): Promise<PacoteMinimo> {
    const id = `PAC-${String(this.#contadorPacote++).padStart(4, '0')}`;
    const dataExpira =
      expiraEm ?? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().split('T')[0];

    const pacote: PacoteMinimo = {
      id,
      missao,
      pessoa,
      destinatario,
      finalidade,
      campos: camposPartilhados,
      naoPartilha: camposNaoPartilhados,
      expiraEm: dataExpira,
      aprovadoEm: null,
    };

    this.#pacotes.set(id, pacote);
    await this.#guardarPacoteNaBase(pacote);

    await this.#registo.registar({
      tipo: 'cofre.pacote.preparado',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'agente',
      simulacao: true,
      dados: {
        pacote: id,
        destinatario,
        finalidade,
        campos: Object.keys(camposPartilhados),
        nao_partilha: camposNaoPartilhados,
        expira_em: dataExpira,
      },
    });

    return pacote;
  }

  /**
   * Aprovação formal do pacote mínimo pela pessoa.
   */
  async aprovarPacoteMinimo(pessoa: string, missao: string, pacoteId: string): Promise<PacoteMinimo | null> {
    const pacote = this.#pacotes.get(pacoteId);
    if (!pacote || pacote.pessoa !== pessoa) return null;

    pacote.aprovadoEm = new Date().toISOString();
    await this.#guardarPacoteNaBase(pacote);

    await this.#registo.registar({
      tipo: 'cofre.pacote.aprovado',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'pessoa',
      simulacao: true,
      dados: {
        pacote: pacoteId,
        campos: Object.keys(pacote.campos),
        nao_partilha: pacote.naoPartilha,
        aprovado_em: pacote.aprovadoEm,
      },
    });

    return pacote;
  }

  obterPacote(pacoteId: string): PacoteMinimo | undefined {
    return this.#pacotes.get(pacoteId);
  }

  listarPacotes(pessoa: string): PacoteMinimo[] {
    return Array.from(this.#pacotes.values()).filter((p) => p.pessoa === pessoa);
  }
}


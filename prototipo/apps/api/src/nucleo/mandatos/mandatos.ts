/**
 * Gestão de Mandatos Digitais Representativos.
 *
 * Princípio da Lealdade do Henriques:
 * O Henriques é um representante digital leal, agindo apenas nos limites estritos
 * da autorização delegada pela pessoa.
 *
 * Níveis de Mandato:
 *   - D0: Informar (apenas leitura do registo oficial)
 *   - D1: Vigiar (consultar estado e alterações de processos existentes)
 *   - D2: Preparar (criar rascunhos sem submissão formal)
 *   - D3: Agir com Confirmação (submeter formalmente mediante confirmação da pessoa)
 *   - D4: Agir dentro de regras predefinidas (indisponível em R0)
 */
import type { Registo } from '../eventos/registo.js';

export type NivelMandato = 'D0' | 'D1' | 'D2' | 'D3' | 'D4';
export type EstadoMandato = 'ativo' | 'revogado' | 'expirado';

const ORDEM_NIVEIS: Record<NivelMandato, number> = {
  D0: 0,
  D1: 1,
  D2: 2,
  D3: 3,
  D4: 4,
};

export interface MandatoDigital {
  id: string; // ex: MAN-2026-0001
  mandante: string; // pessoa:demo-ines
  representante: string; // delegate:henriques
  ambito: string; // ex: ocupacao-espaco-publico
  objeto: string; // ex: Casa Joaquim
  entidade: string; // ex: Câmara Municipal de Guimarães
  nivel: NivelMandato;
  validoDe: string;
  validoAte: string;
  estado: EstadoMandato;
  assinatura: {
    metodo: 'simulada' | 'cmd';
    em: string;
  };
  revogadoEm: string | null;
}

export class GestorMandatos {
  readonly #registo: Registo;
  readonly #sessao: string;
  readonly #mandatos = new Map<string, MandatoDigital>();
  #contador = 1;

  constructor(registo: Registo, sessao: string = 'demo') {
    this.#registo = registo;
    this.#sessao = sessao;
  }

  /**
   * Propõe um mandato à pessoa para realização de uma missão.
   */
  async proporMandato(
    mandante: string,
    missao: string | null,
    ambito: string,
    nivel: NivelMandato,
    objeto: string,
  ): Promise<void> {
    await this.#registo.registar({
      tipo: 'mandato.proposto',
      origem: 'mandatos',
      sessao: this.#sessao,
      pessoa: mandante,
      missao,
      ator: 'agente',
      simulacao: true,
      dados: {
        ambito,
        nivel,
        objeto,
      },
    });
  }

  /**
   * Concede formalmente um mandato com nível e validade definidos.
   */
  async concederMandato(
    mandante: string,
    missao: string | null,
    params: {
      ambito: string;
      objeto: string;
      nivel: NivelMandato;
      entidade?: string;
      validadeDias?: number;
    },
  ): Promise<MandatoDigital> {
    const id = `MAN-${new Date().getFullYear()}-${String(this.#contador++).padStart(4, '0')}`;
    const agora = new Date();
    const dias = params.validadeDias ?? 365;
    const validoAte = new Date(agora.getTime() + dias * 24 * 3600 * 1000);

    const mandato: MandatoDigital = {
      id,
      mandante,
      representante: 'delegate:henriques',
      ambito: params.ambito,
      objeto: params.objeto,
      entidade: params.entidade ?? 'Câmara Municipal de Guimarães',
      nivel: params.nivel,
      validoDe: agora.toISOString().split('T')[0],
      validoAte: validoAte.toISOString().split('T')[0],
      estado: 'ativo',
      assinatura: {
        metodo: 'simulada',
        em: agora.toISOString(),
      },
      revogadoEm: null,
    };

    this.#mandatos.set(id, mandato);

    await this.#registo.registar({
      tipo: 'mandato.concedido',
      origem: 'mandatos',
      sessao: this.#sessao,
      pessoa: mandante,
      missao,
      ator: 'pessoa',
      simulacao: true,
      dados: {
        id,
        nivel: mandato.nivel,
        ambito: mandato.ambito,
        objeto: mandato.objeto,
        entidade: mandato.entidade,
        valido_ate: mandato.validoAte,
      },
    });

    return mandato;
  }

  /**
   * Regista a recusa de concessão de mandato.
   */
  async recusarMandato(
    mandante: string,
    missao: string | null,
    ambito: string,
    motivo?: string,
  ): Promise<void> {
    await this.#registo.registar({
      tipo: 'mandato.recusado',
      origem: 'mandatos',
      sessao: this.#sessao,
      pessoa: mandante,
      missao,
      ator: 'pessoa',
      simulacao: true,
      dados: {
        ambito,
        motivo: motivo ?? 'recusa_da_pessoa',
      },
    });
  }

  /**
   * Revoga imediatamente um mandato anteriormente concedido.
   */
  async revogarMandato(mandante: string, mandatoId: string): Promise<boolean> {
    const mandato = this.#mandatos.get(mandatoId);
    if (!mandato || mandato.mandante !== mandante) return false;

    mandato.estado = 'revogado';
    mandato.revogadoEm = new Date().toISOString();

    await this.#registo.registar({
      tipo: 'mandato.revogado',
      origem: 'mandatos',
      sessao: this.#sessao,
      pessoa: mandante,
      missao: null,
      ator: 'pessoa',
      simulacao: true,
      dados: {
        id: mandatoId,
        ambito: mandato.ambito,
        nivel: mandato.nivel,
        revogado_em: mandato.revogadoEm,
      },
    });

    return true;
  }

  /**
   * Revoga todos os mandatos concedidos por uma determinada pessoa (ex.: ao reiniciar com /start).
   */
  async revogarTodosPorPessoa(mandante: string): Promise<number> {
    const ativos = Array.from(this.#mandatos.values()).filter(
      (m) => m.mandante === mandante && m.estado === 'ativo',
    );
    for (const m of ativos) {
      await this.revogarMandato(mandante, m.id);
    }
    return ativos.length;
  }

  /**
   * Verifica se existe um mandato ativo que satisfaça o âmbito e o nível mínimo requerido.
   */
  verificar(
    mandante: string,
    ambito: string,
    nivelRequerido: NivelMandato,
  ): { valido: boolean; mandato?: MandatoDigital; razao?: string } {
    const ativos = Array.from(this.#mandatos.values()).filter(
      (m) => m.mandante === mandante && m.estado === 'ativo',
    );

    const correspondente = ativos.find(
      (m) => (m.ambito === ambito || m.ambito === '*') && ORDEM_NIVEIS[m.nivel] >= ORDEM_NIVEIS[nivelRequerido],
    );

    if (!correspondente) {
      return {
        valido: false,
        razao: `Nenhum mandato ativo para o âmbito «${ambito}» com nível mínimo ${nivelRequerido}.`,
      };
    }

    const hoje = new Date().toISOString().split('T')[0];
    if (correspondente.validoAte < hoje) {
      correspondente.estado = 'expirado';
      return {
        valido: false,
        razao: `O mandato ${correspondente.id} expirou em ${correspondente.validoAte}.`,
      };
    }

    return { valido: true, mandato: correspondente };
  }

  listar(mandante: string): MandatoDigital[] {
    return Array.from(this.#mandatos.values()).filter((m) => m.mandante === mandante);
  }

  obter(mandatoId: string): MandatoDigital | undefined {
    return this.#mandatos.get(mandatoId);
  }
}

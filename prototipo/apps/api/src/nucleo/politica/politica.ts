/**
 * Motor de Política Declarativo do Núcleo.
 *
 * Avalia ações do agente ou da pessoa segundo três decisões possíveis:
 *   - 'permitir': ação autorizada e em conformidade;
 *   - 'confirmar': ação sensível que requer confirmação expressa da pessoa (ex.: Chave Móvel Digital);
 *   - 'bloquear': ação não autorizada, fora de competência ou sem mandato suficiente.
 *
 * Emite o evento:
 *   - politica.decisao
 */
import type { Registo } from '../eventos/registo.js';
import type { GestorMandatos, NivelMandato } from '../mandatos/mandatos.js';

export type ResultadoPolitica = 'permitir' | 'confirmar' | 'bloquear';

export interface DecisaoPolitica {
  resultado: ResultadoPolitica;
  regra: string;
  motivo: string;
  exigeConfirmacao: boolean;
  detalhes?: Record<string, unknown>;
}

export class MotorPolitica {
  readonly #registo: Registo;
  readonly #mandatos: GestorMandatos;
  readonly #sessao: string;

  constructor(registo: Registo, mandatos: GestorMandatos, sessao: string = 'demo') {
    this.#registo = registo;
    this.#mandatos = mandatos;
    this.#sessao = sessao;
  }

  /**
   * Avalia uma intenção de execução de capacidade ou ação.
   */
  async avaliarAcao(params: {
    pessoa: string;
    missao: string | null;
    acao: string;
    ambito: string;
    nivelRequerido: NivelMandato;
    temConfirmacao?: boolean;
    dadosSensiveis?: boolean;
    juizoDiscricionario?: boolean;
  }): Promise<DecisaoPolitica> {
    const { pessoa, missao, acao, ambito, nivelRequerido, temConfirmacao, juizoDiscricionario } = params;

    // 1. Juízos discricionários reservados à técnica municipal nunca são permitidos ao agente
    if (juizoDiscricionario) {
      const decisao: DecisaoPolitica = {
        resultado: 'bloquear',
        regra: 'reserva_decisoria_humana',
        motivo: 'Decisões discricionárias de mérito técnico ou urbanístico são de competência exclusiva humana.',
        exigeConfirmacao: false,
      };
      await this.#registarDecisao(pessoa, missao, acao, decisao);
      return decisao;
    }

    // 2. Verificação de mandato ativo
    const check = this.#mandatos.verificar(pessoa, ambito, nivelRequerido);
    if (!check.valido) {
      const decisao: DecisaoPolitica = {
        resultado: 'bloquear',
        regra: 'mandato_insuficiente',
        motivo: check.razao ?? `Falta mandato com nível ${nivelRequerido} para ${ambito}.`,
        exigeConfirmacao: false,
      };
      await this.#registarDecisao(pessoa, missao, acao, decisao);
      return decisao;
    }

    // 3. Ações com nível D3 (submissões com efeitos jurídicos) exigem confirmação expressa
    if (nivelRequerido === 'D3' && !temConfirmacao) {
      const decisao: DecisaoPolitica = {
        resultado: 'confirmar',
        regra: 'confirmacao_humana_obrigatoria_d3',
        motivo: 'A submissão formal de procedimentos vinculativos exige confirmação expressa da pessoa.',
        exigeConfirmacao: true,
        detalhes: { mandatoId: check.mandato?.id },
      };
      await this.#registarDecisao(pessoa, missao, acao, decisao);
      return decisao;
    }

    // 4. Tudo verificado: permitir
    const decisao: DecisaoPolitica = {
      resultado: 'permitir',
      regra: 'conformidade_estrita',
      motivo: `Ação autorizada ao abrigo do mandato ${check.mandato?.id} (${check.mandato?.nivel}).`,
      exigeConfirmacao: false,
      detalhes: { mandatoId: check.mandato?.id },
    };
    await this.#registarDecisao(pessoa, missao, acao, decisao);
    return decisao;
  }

  async #registarDecisao(
    pessoa: string,
    missao: string | null,
    acao: string,
    decisao: DecisaoPolitica,
  ): Promise<void> {
    await this.#registo.registar({
      tipo: 'politica.decisao',
      origem: 'politica',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'sistema',
      simulacao: true,
      dados: {
        acao,
        resultado: decisao.resultado,
        regra: decisao.regra,
        motivo: decisao.motivo,
        exige_confirmacao: decisao.exigeConfirmacao,
        ...decisao.detalhes,
      },
    });
  }
}

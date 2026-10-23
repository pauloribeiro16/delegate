/**
 * Serviço de Chaves do Cofre (simulação honesta de HSM / Módulo de Segurança).
 *
 * Princípio constitucional de privacidade:
 * O operador não lê o cofre. A chave criptográfica só é libertada temporariamente
 * para uma missão ativa que possua mandato válido concedido pela pessoa.
 *
 * Emite os eventos do contrato:
 *   - cofre.chave.libertada
 *   - cofre.chave.recolhida
 */
import type { Registo } from '../eventos/registo.js';
import { derivarChavePessoa } from './cifra.js';

export interface ConcessaoChave {
  chave: Buffer;
  expiraEm: Date;
  missao: string;
  pessoa: string;
  temporizador?: NodeJS.Timeout;
}

export class ServicoChavesCofre {
  readonly #registo: Registo;
  readonly #sessao: string;
  readonly #concessoes = new Map<string, ConcessaoChave>(); // chave: "pessoa:missao"

  constructor(registo: Registo, sessao: string = 'demo') {
    this.#registo = registo;
    this.#sessao = sessao;
  }

  /**
   * Liberta temporariamente a chave de cifragem para uma missão autorizada.
   * Validade padrão: 10 minutos (600.000 ms).
   */
  async libertarChave(
    pessoa: string,
    missao: string,
    mandatoId: string,
    duracaoMs: number = 10 * 60 * 1000,
  ): Promise<Buffer> {
    const chaveMapa = `${pessoa}:${missao}`;
    const existente = this.#concessoes.get(chaveMapa);
    if (existente && existente.expiraEm > new Date()) {
      return existente.chave;
    }

    const chave = derivarChavePessoa(pessoa);
    const expiraEm = new Date(Date.now() + duracaoMs);

    const temporizador = setTimeout(() => {
      void this.recolherChave(pessoa, missao, 'expiracao_tempo');
    }, duracaoMs);

    this.#concessoes.set(chaveMapa, {
      chave,
      expiraEm,
      missao,
      pessoa,
      temporizador,
    });

    await this.#registo.registar({
      tipo: 'cofre.chave.libertada',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'sistema',
      simulacao: true,
      dados: {
        mandato: mandatoId,
        expira_em: expiraEm.toISOString(),
        duracao_minutos: Math.round(duracaoMs / 60000),
      },
    });

    return chave;
  }

  /**
   * Recolhe a chave imediatamente e anula a concessão.
   */
  async recolherChave(
    pessoa: string,
    missao: string,
    motivo: string = 'conclusao_missao',
  ): Promise<void> {
    const chaveMapa = `${pessoa}:${missao}`;
    const concessao = this.#concessoes.get(chaveMapa);
    if (!concessao) return;

    if (concessao.temporizador) {
      clearTimeout(concessao.temporizador);
    }
    this.#concessoes.delete(chaveMapa);

    await this.#registo.registar({
      tipo: 'cofre.chave.recolhida',
      origem: 'cofre',
      sessao: this.#sessao,
      pessoa,
      missao,
      ator: 'sistema',
      simulacao: true,
      dados: {
        motivo,
      },
    });
  }

  /**
   * Obtém a chave ativa se ainda estiver dentro do prazo de concessão.
   */
  obterChaveAtiva(pessoa: string, missao: string): Buffer | null {
    const concessao = this.#concessoes.get(`${pessoa}:${missao}`);
    if (!concessao) return null;
    if (concessao.expiraEm <= new Date()) {
      this.#concessoes.delete(`${pessoa}:${missao}`);
      return null;
    }
    return concessao.chave;
  }
}

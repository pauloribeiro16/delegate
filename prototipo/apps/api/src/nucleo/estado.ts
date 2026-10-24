/**
 * O estado operacional do núcleo, quando corre fora do processo local.
 *
 * Localmente, o cofre, os mandatos, as missões e o rascunho D2 vivem em memória
 * — um só processo, um só estado. No alojamento (Vercel), cada função é uma
 * instância com a sua memória: o rascunho de uma esplanada começada num
 * pedido desapareceria no pedido seguinte.
 *
 * Este armazenamento é a base comum: uma tabela, uma linha por estado, sempre
 * com a pessoa à quem pertence. Sem ele (modo local), nada muda.
 */
export interface EstadoGuardado {
  tipo: string;
  pessoa: string;
  id: string;
  dados: unknown;
  atualizado: string;
}

export interface ConsultaEstado {
  query(sql: string, valores?: unknown[]): Promise<{ rows: any[] }>;
}

export class ArmazenamentoEstado {
  readonly #base: ConsultaEstado;

  constructor(base: ConsultaEstado) {
    this.#base = base;
  }

  async preparar(): Promise<void> {
    await this.#base.query(
      `CREATE TABLE IF NOT EXISTS nucleo.estado (
         tipo      TEXT NOT NULL,
         pessoa    TEXT NOT NULL,
         id        TEXT NOT NULL,
         dados     JSONB NOT NULL,
         atualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (tipo, id)
       )`,
    );
    await this.#base.query('CREATE INDEX IF NOT EXISTS estado_pessoa ON nucleo.estado (pessoa, tipo)');
  }

  /** Todos os estados de um tipo para uma pessoa — o que a instância precisa de saber. */
  async listar(tipo: string, pessoa: string): Promise<EstadoGuardado[]> {
    const { rows } = await this.#base.query(
      'SELECT tipo, pessoa, id, dados, atualizado FROM nucleo.estado WHERE tipo = $1 AND pessoa = $2',
      [tipo, pessoa],
    );
    return rows.map((r) => ({
      tipo: r.tipo,
      pessoa: r.pessoa,
      id: r.id,
      dados: r.dados,
      atualizado: new Date(r.atualizado).toISOString(),
    }));
  }

  /** Todos os estados de um tipo, sem filtrar pessoa (missões e mandatoshap-de todos). */
  async listarTipo(tipo: string): Promise<EstadoGuardado[]> {
    const { rows } = await this.#base.query(
      'SELECT tipo, pessoa, id, dados, atualizado FROM nucleo.estado WHERE tipo = $1',
      [tipo],
    );
    return rows.map((r) => ({
      tipo: r.tipo,
      pessoa: r.pessoa,
      id: r.id,
      dados: r.dados,
      atualizado: new Date(r.atualizado).toISOString(),
    }));
  }

  async gravar(tipo: string, pessoa: string, id: string, dados: unknown): Promise<void> {
    await this.#base.query(
      `INSERT INTO nucleo.estado (tipo, pessoa, id, dados, atualizado) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tipo, id) DO UPDATE SET dados = EXCLUDED.dados, pessoa = EXCLUDED.pessoa, atualizado = now()`,
      [tipo, pessoa, id, JSON.stringify(dados)],
    );
  }

  async apagar(tipo: string, id: string): Promise<void> {
    await this.#base.query('DELETE FROM nucleo.estado WHERE tipo = $1 AND id = $2', [tipo, id]);
  }

  /** Apaga tudo o que pertence a uma pessoa (quando o /start reinicia a sessão). */
  async limparPessoa(pessoa: string): Promise<void> {
    await this.#base.query('DELETE FROM nucleo.estado WHERE pessoa = $1', [pessoa]);
  }
}

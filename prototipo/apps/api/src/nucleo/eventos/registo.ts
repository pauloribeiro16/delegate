/**
 * O registo de eventos: onde os eventos nascem e ficam.
 *
 * Só de acréscimo, encadeados por selo. A tabela tem um gatilho que notifica,
 * de modo que quem escuta não precisa de perguntar nada.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  Envelope as Esquema,
  selar,
  verificarCadeia,
  type Envelope,
  type EventoGuardado,
  type Pedido,
} from '../../../../../packages/eventos/src/index.js';

const COLUNAS = `v, id, ts, tipo, origem, sessao, missao, pessoa, ator, simulacao, dados, hash_anterior, hash`;

const INSERIR = `INSERT INTO nucleo.eventos (${COLUNAS})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING seq`;

function linhaParaEvento(linha: Record<string, unknown>): Envelope {
  return {
    v: 1,
    id: String(linha.id),
    ts: (linha.ts as Date).toISOString(),
    tipo: String(linha.tipo),
    origem: String(linha.origem) as Envelope['origem'],
    sessao: String(linha.sessao),
    missao: (linha.missao as string | null) ?? null,
    pessoa: (linha.pessoa as string | null) ?? null,
    ator: String(linha.ator) as Envelope['ator'],
    simulacao: Boolean(linha.simulacao),
    dados: (linha.dados as Record<string, unknown>) ?? {},
    hash_anterior: (linha.hash_anterior as string | null) ?? null,
    hash: String(linha.hash),
  };
}

export class Registo {
  readonly #escrita: pg.Client | pg.Pool;

  constructor(escrita: pg.Client | pg.Pool) {
    this.#escrita = escrita;
  }

  /**
   * Sela, valida e grava um evento.
   *
   * A validação não é decoração: é o que impõe as três regras de privacidade
   * que o contrato promete — pseudónimo, nada de conteúdo do Cofre em claro, e
   * texto de conversa só em eventos de canal.
   */
  async registar(pedido: Pedido): Promise<EventoGuardado> {
    // Só precisamos do selo anterior — não do evento anterior inteiro.
    const { rows: ultimos } = await this.#escrita.query<{ hash: string }>(
      'SELECT hash FROM nucleo.eventos ORDER BY seq DESC LIMIT 1',
    );

    const evento = selar(
      {
        v: 1,
        simulacao: false,
        id: randomUUID(),
        ts: new Date().toISOString(),
        ...pedido,
      },
      ultimos[0] ? ({ hash: ultimos[0].hash } as Envelope) : null,
    );

    // Se o evento não cumpre o contrato, não entra na auditoria.
    const valido = Esquema.parse(evento);

    const { rows } = await this.#escrita.query<{ seq: number }>(INSERIR, [
      valido.v,
      valido.id,
      valido.ts,
      valido.tipo,
      valido.origem,
      valido.sessao,
      valido.missao,
      valido.pessoa,
      valido.ator,
      valido.simulacao,
      JSON.stringify(valido.dados),
      valido.hash_anterior,
      valido.hash,
    ]);
    return { ...valido, seq: rows[0]!.seq };
  }

  /** Os eventos a partir de uma sequência, para o browser recuperar. */
  async desde(seq: number, limite = 200, sessao?: string): Promise<EventoGuardado[]> {
    const { rows } = await this.#escrita.query(
      `SELECT seq, ${COLUNAS} FROM nucleo.eventos
       WHERE seq > $1 ${sessao ? 'AND sessao = $3' : ''}
       ORDER BY seq ASC LIMIT $2`,
      sessao ? [seq, limite, sessao] : [seq, limite],
    );
    return rows.map((l) => ({
      ...linhaParaEvento(l as Record<string, unknown>),
      seq: Number((l as { seq: string | number }).seq),
    }));
  }

  /** Lista os eventos a partir de uma sequência ou por filtro. */
  async listar(filtros: { sessao?: string; limite?: number } = {}): Promise<EventoGuardado[]> {
    return this.desde(0, filtros.limite ?? 100, filtros.sessao);
  }

  /** Devolve a lista de processos municipais conhecidos a partir dos eventos gravados. */
  async listarProcessosMunicipais(): Promise<Array<{ processo: string; dados: any; seq: number }>> {
    const { rows } = await this.#escrita.query(
      `SELECT seq, dados FROM nucleo.eventos
       WHERE tipo = 'consola.caso.criado' OR tipo = 'su.processo.criado'
       ORDER BY seq ASC`,
    );
    return rows.map((r: any) => ({
      processo: r.dados?.processo || 'OEP/2026/0001',
      dados: r.dados,
      seq: Number(r.seq),
    }));
  }

  /** Lista o histórico completo de decisões classificadas do Henriques / TypeSafe Jev. */
  async listarDecisoes(limite = 100, sessao?: string): Promise<EventoGuardado[]> {
    const { rows } = await this.#escrita.query(
      `SELECT seq, ${COLUNAS} FROM nucleo.eventos
       WHERE (tipo = 'henriques.intencao.classificada' OR tipo = 'henriques.resposta.verificada' OR tipo = 'henriques.resposta.abstencao' OR tipo = 'canal.mensagem.recebida' OR tipo = 'canal.mensagem.enviada')
       ${sessao ? 'AND sessao = $2' : ''}
       ORDER BY seq DESC LIMIT $1`,
      sessao ? [limite, sessao] : [limite],
    );
    return rows.map((l) => ({
      ...linhaParaEvento(l as Record<string, unknown>),
      seq: Number((l as { seq: string | number }).seq),
    }));
  }

  /** Um evento pelo seu número de sequência. É o que o NOTIFY traz. */
  async porSeq(seq: number): Promise<EventoGuardado | null> {
    const { rows } = await this.#escrita.query(
      `SELECT seq, ${COLUNAS} FROM nucleo.eventos WHERE seq = $1`,
      [seq],
    );
    const linha = rows[0] as Record<string, unknown> | undefined;
    return linha ? { ...linhaParaEvento(linha), seq: Number(linha.seq) } : null;
  }

  /** Confirma que a cadeia inteira fecha. É o teste de auditoria. */
  async verificar(): Promise<{ valido: boolean; total: number; quebradoEm: number | null }> {
    const { rows } = await this.#escrita.query(
      `SELECT seq, ${COLUNAS} FROM nucleo.eventos ORDER BY seq ASC`,
    );
    // O Postgres devolve BIGINT como cadeia; o número de sequência é um número.
    const eventos = rows.map((l) => ({
      ...linhaParaEvento(l as Record<string, unknown>),
      seq: Number((l as { seq: string | number }).seq),
    }));
    const v = verificarCadeia(eventos);
    return { valido: v.valido, total: eventos.length, quebradoEm: v.quebradoEm };
  }
}
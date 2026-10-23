/**
 * A cadeia de selos. Cada evento aponta para o anterior e leva o seu próprio
 * resumo, o que torna o registo verificável: se alguém mexer num evento
 * antigo, todos os elos seguintes deixam de fechar.
 *
 * É esta cadeia que é a auditoria (ADR-015). Não há tabela separada.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Envelope, type Pedido } from './envelope.js';

/**
 * Ordena as chaves em profundidade, para que o mesmo conteúdo dê sempre o
 * mesmo resumo.
 *
 * Isto não é vaidade: resolve dois defeitos ao mesmo tempo.
 *
 * O primeiro é que o resumo tem de cobrir `dados`, e não só o envelope. Passar
 * as chaves do envelope a `JSON.stringify` filtra a *todos* os níveis, e
 * nenhuma chave de `dados` está nessa lista — o conteúdo sumia do resumo, e
 * dois eventos com textos completamente diferentes ficavam iguais.
 *
 * O segundo é que o Postgres guarda `dados` como JSONB, e o JSONB normaliza a
 * ordem das chaves ao gravar. Ordenando antes de resumir, o resumo é o mesmo
 * quando o evento volta da base, apesar de lá ter chegado por outra ordem.
 */
function canonizar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonizar);
  if (valor !== null && typeof valor === 'object') {
    const paragens = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(paragens.map(([chave, v]) => [chave, canonizar(v)]));
  }
  return valor;
}

/**
 * Os campos do envelope, por ordem. Só estes entram no resumo.
 *
 * Escolher explicitamente em vez de pegar no que o objecto tem resolve dois
 * problemas ao mesmo tempo: o número de sequência que a base acrescenta ao
 * evento deixa de contaminar o resumo, e qualquer campo novo que apareça não
 * altera retroactivamente os selos já gravados.
 */
const CAMPOS = [
  'v',
  'id',
  'ts',
  'tipo',
  'origem',
  'sessao',
  'missao',
  'pessoa',
  'ator',
  'simulacao',
  'dados',
  'hash_anterior',
] as const;

/** Resumo canónico: as mesmas chaves, por ordem, produzem sempre o mesmo resumo. */
export function calcularHash(evento: Omit<Envelope, 'hash'>): string {
  const semHash = evento as Record<string, unknown>;
  const conteudo = Object.fromEntries(
    CAMPOS.filter((campo) => campo !== 'v' || semHash.v !== undefined).map((campo) => [
      campo,
      canonizar(semHash[campo]),
    ]),
  );
  return createHash('sha256').update(JSON.stringify(conteudo)).digest('hex');
}

/** Sela um pedido num evento completo, ligado ao anterior. */
export function selar(pedido: Pedido, anterior: Envelope | null): Envelope {
  const base: Omit<Envelope, 'hash'> = {
    v: 1,
    id: pedido.id ?? randomUUID(),
    ts: pedido.ts ?? new Date().toISOString(),
    tipo: pedido.tipo,
    origem: pedido.origem,
    sessao: pedido.sessao,
    missao: pedido.missao ?? null,
    pessoa: pedido.pessoa ?? null,
    ator: pedido.ator,
    simulacao: pedido.simulacao ?? false,
    dados: pedido.dados ?? {},
    hash_anterior: pedido.hash_anterior ?? anterior?.hash ?? null,
  };
  return { ...base, hash: calcularHash(base) };
}

export interface Verificacao {
  valido: boolean;
  /** Quantos elos fecharam. */
  elos: number;
  /** Número de sequência do primeiro evento que não fecha, se algum. */
  quebradoEm: number | null;
}

/**
 * Percorre a cadeia e diz se fecha de ponta a ponta. `seq` vem do registo para
 * que o diagnóstico aponte para o evento certo e não para a sua posição.
 */
export function verificarCadeia(eventos: readonly (Envelope & { seq?: number })[]): Verificacao {
  let anterior: Envelope | null = null;

  for (const [indice, evento] of eventos.entries()) {
    const onde = evento.seq ?? indice;
    if (evento.hash_anterior !== (anterior?.hash ?? null)) {
      return { valido: false, elos: indice, quebradoEm: onde };
    }
    if (calcularHash(evento) !== evento.hash) {
      return { valido: false, elos: indice, quebradoEm: onde };
    }
    anterior = evento;
  }

  return { valido: true, elos: eventos.length, quebradoEm: null };
}
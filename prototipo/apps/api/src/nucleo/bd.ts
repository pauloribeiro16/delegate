/**
 * A base de dados do núcleo.
 *
 * Dois modos:
 *  - Local (omissão): PostgreSQL embutido, com esquemas separados. Os esquemas
 *    simulam bases isoladas — é isso que impede que uma rota simulada sirva de
 *    atalho para outra. O embutido importa-se àcara de necessidade: no Vercel
 *    o pacote nem existe, e a função alojada nunca entra neste ramo.
 *  - Alojado (quando existe DATABASE_URL): um PostgreSQL externo (ex.: Neon no
 *    Vercel), ligação por SSL. É o modo das funções serverless — o mesmo
 *    esquema, sem embutido.
 */
import pg from 'pg';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

export const PORTAS = {
  nucleo: 5433,
  porta: 5434,
} as const;

export const SESSAO = process.env.SESSAO ?? 'demo';
const SENHA = 'delegado';

/** URL de uma base externa (Neon/Vercel Postgres). Presente = modo alojado. */
export const URL_BASE_EXTERNA = process.env.DATABASE_URL?.trim() || null;

export interface Base {
  escrita: pg.Client | pg.Pool;
  novaLigacao(): pg.Client | pg.Pool;
  escutar(): Promise<pg.Client>;
  fechar(): Promise<void>;
}

const ESCOLAS = ['nucleo', 'porta', 'su_simulado', 'tesouraria_simulada'];

const SQL = [
  ...ESCOLAS.map((e) => `CREATE SCHEMA IF NOT EXISTS ${e}`),
  `CREATE TABLE IF NOT EXISTS nucleo.eventos (
     seq           BIGSERIAL PRIMARY KEY,
     v             SMALLINT NOT NULL DEFAULT 1,
     id            TEXT NOT NULL,
     ts            TIMESTAMPTZ NOT NULL,
     tipo          TEXT NOT NULL,
     origem        TEXT NOT NULL,
     sessao        TEXT NOT NULL,
     missao        TEXT,
     pessoa        TEXT,
     ator          TEXT NOT NULL,
     simulacao     BOOLEAN NOT NULL,
     dados         JSONB NOT NULL,
     hash_anterior TEXT,
     hash          TEXT NOT NULL
   )`,
  // O gatilho é o que transforma um evento numa notificação. Sem ele, o ecrã
  // teria de perguntar se há novidades — e um fluxo de eventos que pergunta
  // é um fluxo que atrasa.
  `CREATE OR REPLACE FUNCTION nucleo.notificar() RETURNS trigger AS $$
     BEGIN
       PERFORM pg_notify('eventos', NEW.seq::TEXT);
       RETURN NEW;
     END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS evento_notifica ON nucleo.eventos`,
  `CREATE TRIGGER evento_notifica AFTER INSERT ON nucleo.eventos
     FOR EACH ROW EXECUTE FUNCTION nucleo.notificar()`,
];

export interface OpcoesBase {
  /** Pasta do cluster. Por omissão, a do núcleo. */
  pasta?: string;
  /** Porto. Por omissão, o do núcleo. */
  porta?: number;
  /** Apaga o cluster existente ao arrancar. Para testes. */
  recriar?: boolean;
}

/**
 * Ligação a uma base externa (DATABASE_URL). Um pool, porque cada função
 * serverless partilha a instância entre pedidos e o SSL é obrigatório no Neon.
 * O esquema é o mesmo do modo local e cria-se de forma idempotente.
 */
async function abrirBaseExterna(url: string): Promise<Base> {
  const ssl = url.includes('sslmode=') ? {} : { ssl: { rejectUnauthorized: false } };
  const pool = new pg.Pool({ connectionString: url, max: 5, ...ssl });
  pool.on('error', (err: Error) => {
    console.warn('⚠ aviso no pool pg externo:', err.message);
  });

  const escrita = await pool.connect();
  try {
    for (const instrucao of SQL) await escrita.query(instrucao);
  } finally {
    escrita.release();
  }

  let clienteEscuta: pg.Client | null = null;
  return {
    escrita: pool,
    novaLigacao: () => pool,
    async escutar() {
      // Uma ligação só para escutar. Nunca do pool: o pool fecha ligações e a
      // subscrição vai com elas.
      if (!clienteEscuta || clienteEscuta.connection === null) {
        clienteEscuta = new pg.Client({ connectionString: url, ...ssl });
        await clienteEscuta.connect();
      }
      return clienteEscuta;
    },
    async fechar() {
      await pool.end().catch(() => {});
    },
  };
}

/**
 * Arranca a base e devolve as ligações de que o núcleo precisa.
 *
 * A pasta e o porto são parâmetros porque cada processo tem de ter a sua: dois
 * servidores sobre o mesmo directório de dados corrompem a base. É o que
 * separa o núcleo da Porta e dos sistemas simulados.
 */
export async function abrirBase(opcoes: OpcoesBase = {}): Promise<Base> {
  if (URL_BASE_EXTERNA) return abrirBaseExterna(URL_BASE_EXTERNA);

  // Importe-se aqui: no alojamento este ramo nunca corre e o pacote nem existe.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pasta = opcoes.pasta ?? resolve(import.meta.dirname, '../../../../.pgdata');
  const porta = opcoes.porta ?? PORTAS.nucleo;

  if (opcoes.recriar) await rm(pasta, { recursive: true, force: true });

  const servidor = new EmbeddedPostgres({
    databaseDir: pasta,
    user: 'postgres',
    password: SENHA,
    port: porta,
    persistent: true,
  });

  const jaExiste = await existe(pasta);
  if (!jaExiste) await servidor.initialise();
  await servidor.start();

  const ligacao = (database = 'postgres') => {
    const c = new pg.Client({ host: '127.0.0.1', port: porta, user: 'postgres', password: SENHA, database });
    c.on('error', (err: Error) => {
      console.warn('⚠ aviso na ligação pg:', err.message);
    });
    return c;
  };

  const admin = ligacao();
  await admin.connect();
  const existeDelegado = await admin
    .query('SELECT 1 FROM pg_database WHERE datname = $1', ['delegado'])
    .then((r) => (r.rowCount ?? 0) > 0);
  if (!existeDelegado) await admin.query('CREATE DATABASE delegado');
  await admin.end();

  const escrita = ligacao('delegado');
  await escrita.connect();
  for (const instrucao of SQL) await escrita.query(instrucao);

  return {
    escrita,
    novaLigacao: () => ligacao('delegado'),
    async escutar() {
      const c = ligacao('delegado');
      await c.connect();
      return c;
    },
    async fechar() {
      await escrita.end().catch(() => {});
      await servidor.stop().catch(() => {});
    },
  };
}

async function existe(pasta: string): Promise<boolean> {
  const { existsSync } = await import('node:fs');
  return existsSync(resolve(pasta, 'PG_VERSION'));
}

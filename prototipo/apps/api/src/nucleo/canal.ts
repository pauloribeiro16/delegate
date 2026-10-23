/**
 * O canal: a única coisa do protótipo que fala com o Telegram.
 *
 * Por baixo de uma interface de cinco métodos, para que a lógica do Henriques
 * nunca saiba com quem está a falar. É isto que permite escrever e testar as
 * respostas sem token e sem telemóvel.
 *
 * Ver CANAL.md nestedirectório antes de mexer.
 */
import { Bot, GrammyError, HttpError, InputFile, type Context } from 'grammy';
import { createHmac } from 'node:crypto';

/** Chave dos pseudónimos. Só a sessão a conhece, por isso não é reversível. */
const SEGREDO_DA_SESSAO = process.env.SESSAO ?? 'demo';

/** De onde veio a mensagem. Nunca se adivinha pelo conteúdo. */
export type TipoEntrada = 'texto' | 'comando' | 'foto' | 'documento' | 'botao';

/** Uma actualização recebida do canal, já normalizada. */
export interface MensagemRecebida {
  /** Pseudónimo da pessoa. Nunca o identificador do Telegram. */
  pessoa: string;
  tipo: TipoEntrada;
  /** Texto, se houver. */
  texto: string | null;
  /** Identificador da foto, se houver. Nunca descarregamos bytes. */
  foto: string | null;
  /** Metadados do documento/PDF se houver. */
  documento?: { nome: string; mime?: string; id: string } | null;
  /** Fila onde veio, para onde vai a resposta. */
  conversa: string;
  /** Data em ISO, do próprio Telegram. */
  quando: string;
}

/** Um botão de decisão. */
export interface Botao {
  texto: string;
  /** O que devolve ao Henriques. Tem de caber em 64 bytes. */
  dados?: string;
  ligacao?: string;
}

/** Botões em linhas: a primeira lista é a primeira linha. */
export type Botoes = Botao[][];

export interface Canal {
  ligar(): Promise<void>;
  enviar(conversa: string, texto: string, botoes?: Botoes): Promise<void>;
  enviarSequencia(
    conversa: string,
    mensagens: string[],
    botoes?: Botoes,
    aoEnviar?: (msg: string, eUltima: boolean) => Promise<void>,
  ): Promise<void>;
  enviarDocumento?(
    conversa: string,
    doc: { nome: string; buffer?: Buffer; caminho?: string; conteudoTexto?: string },
    legenda?: string,
    botoes?: Botoes,
  ): Promise<void>;
  editar(conversa: string, mensagem: number, texto: string, botoes?: Botoes): Promise<void>;
  aEscrever(conversa: string): Promise<void>;
}

export function fracionarResposta(texto: string, categoria?: string): string[] {
  const limpo = texto.trim();
  if (!limpo) return [];

  if (
    categoria === 'geral' ||
    categoria === 'adversarial' ||
    categoria === 'agradecimento' ||
    limpo.length < 220 ||
    !limpo.includes('\n\n')
  ) {
    return [limpo];
  }

  const blocos = limpo
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocos.length <= 1) {
    return [limpo];
  }

  let baloesBase = blocos.length >= 4 || limpo.length > 550 ? 3 : 2;
  const sorte = Math.random();
  let baloesFinal = baloesBase;

  if (baloesBase === 2 && sorte < 0.15) {
    baloesFinal = 1;
  } else if (baloesBase === 2 && sorte > 0.90) {
    baloesFinal = 3;
  } else if (baloesBase === 3 && sorte < 0.12) {
    baloesFinal = 2;
  }

  if (baloesFinal === 1 || blocos.length < 2) {
    return [limpo];
  }

  if (baloesFinal === 2) {
    const ultimoBloco = blocos[blocos.length - 1];
    const ehAcao = /apoio|dizer|carregar|bot[aã]o|posso|quer|basta|ajuda/i.test(ultimoBloco);
    if (ehAcao && blocos.length > 2) {
      const parte1 = blocos.slice(0, blocos.length - 1).join('\n\n');
      const parte2 = ultimoBloco;
      return [parte1, parte2];
    }
    const meio = Math.ceil(blocos.length / 2);
    const parte1 = blocos.slice(0, meio).join('\n\n');
    const parte2 = blocos.slice(meio).join('\n\n');
    return [parte1, parte2];
  }

  if (blocos.length === 2) {
    return [blocos[0], blocos[1]];
  }

  const p1 = blocos[0];
  const p3 = blocos[blocos.length - 1];
  const p2 = blocos.slice(1, blocos.length - 1).join('\n\n');
  return [p1, p2, p3];
}

export function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paraBotoes(botoes?: Botoes) {
  if (!botoes) return undefined;
  return {
    inline_keyboard: botoes.map((linha) =>
      linha.map((b) =>
        b.ligacao && !b.ligacao.includes('localhost') && !b.ligacao.includes('127.0.0.1')
          ? { text: b.texto, url: b.ligacao }
          : { text: b.texto, callback_data: b.dados ?? b.texto },
      ),
    ),
  };
}

/**
 * O pseudónimo é derivado do identificador do Telegram, e nunca sai o
 * identificador em claro.
 *
 * Codificar o número em base 36 não é pseudonymizar: com o pseudónimo à vista,
 * quem sabe converter recupera o número original. Por isso o derivado passa por
 * um resumo com chave, que não é reversível — e a chave muda de sessão, de modo
 * que o mesmo identificador dá pseudónimos diferentes em réplicas diferentes.
 */
function pseudonimo(id: number | undefined): string {
  if (id === undefined) return 'anonimo-0000';
  const resumo = createHmac('sha256', SEGREDO_DA_SESSAO).update(String(id)).digest('hex');
  return `pessoa-${resumo.slice(0, 10)}`;
}

/** Chamado por cada mensagem ou botão que chega. */
export type AoReceber = (m: MensagemRecebida) => void | Promise<void>;

export interface CanalGrammy extends Canal {
  enviarDocumento(
    conversa: string,
    doc: { nome: string; buffer?: Buffer; caminho?: string; conteudoTexto?: string },
    legenda?: string,
    botoes?: Botoes,
  ): Promise<void>;
  parar(): Promise<void>;
  _aoReceber(f: AoReceber): void;
  /** O bot cru, para o modo webhook (Vercel) processar atualizações. */
  _bot(): Bot;
}

export function criarCanalGrammy(token: string): CanalGrammy {
  const bot = new Bot(token);

  let aoReceber: AoReceber = () => {};

  const registar = (bot: Bot) => {
    bot.on('message:text', async (ctx) => {
      await aoReceber({
        pessoa: pseudonimo(ctx.from?.id),
        tipo: ctx.message.text.startsWith('/') ? 'comando' : 'texto',
        texto: ctx.message.text,
        foto: null,
        conversa: String(ctx.chat.id),
        quando: new Date(ctx.message.date * 1000).toISOString(),
      });
    });

    bot.on('message:photo', async (ctx) => {
      // A última da lista é a maior. O Telegram não nos dá os bytes, dá-nos
      // referências — e o identificador pode ser reenviado sem limite.
      const maior = ctx.msg.photo?.at(-1);
      await aoReceber({
        pessoa: pseudonimo(ctx.from?.id),
        tipo: 'foto',
        texto: ctx.msg.caption ?? null,
        foto: maior?.file_id ?? null,
        conversa: String(ctx.chat.id),
        quando: new Date(ctx.msg.date * 1000).toISOString(),
      });
    });

    bot.on('message:document', async (ctx) => {
      const doc = ctx.msg.document;
      await aoReceber({
        pessoa: pseudonimo(ctx.from?.id),
        tipo: 'documento',
        texto: ctx.msg.caption ?? doc?.file_name ?? null,
        foto: null,
        documento: doc ? { nome: doc.file_name ?? 'documento.pdf', mime: doc.mime_type, id: doc.file_id } : null,
        conversa: String(ctx.chat.id),
        quando: new Date(ctx.msg.date * 1000).toISOString(),
      });
    });

    // Um clique é uma mensagem. Mas primeiro responde-se ao clique: o Telegram
    // deixa o relógio a correr no botão durante 30 segundos, e em palco isso
    // vê-se. A resposta sai daqui, antes de qualquer lógica, para que uma
    // falha de negócio nunca deixe a interface pendurada.
    bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await aoReceber({
        pessoa: pseudonimo(ctx.from?.id),
        tipo: 'botao',
        texto: ctx.callbackQuery.data,
        foto: null,
        conversa: String(ctx.callbackQuery.message?.chat.id ?? ctx.chat?.id ?? 0),
        quando: new Date().toISOString(),
      });
    });
  };
  registar(bot);

  // Sem isto, o primeiro erro mata o bot — e a biblioteca avisa disso.
  bot.catch((err) => {
    const erro = err.error;
    if (erro instanceof GrammyError) {
      if (erro.error_code === 409) {
        // Outro processo vivo com este token. A recuperação é matá-lo e arrancar.
        console.error('⚠ 409 — outro processo está a usar este token. Mata-o e arranca de novo.');
        return;
      }
      console.error('✖ Telegram:', erro.error_code, erro.description);
    } else if (erro instanceof HttpError) {
      console.error('✖ Rede:', erro.error);
    } else {
      console.error('✖ Handler:', err);
    }
  });

  return {
    async ligar() {
      await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

      const eu = await bot.api.getMe();
      console.log(`ligado a @${eu.username} — espera mensagens`);

      // start(), nunca run(): a versão concorrente pode perder mensagens.
      let ativo = true;
      while (ativo) {
        try {
          await bot.start({
            drop_pending_updates: false,
            onStart: (info) => console.log(`@${info.username} em modo escuta`),
          });
          ativo = false;
        } catch (err: unknown) {
          if (err instanceof GrammyError && err.error_code === 409) {
            console.warn('⚠ 409 Conflito: outra instância do bot ativa. A aguardar 4s antes de tentar de novo...');
            await new Promise((r) => setTimeout(r, 4000));
          } else {
            throw err;
          }
        }
      }
    },

    async enviar(conversa, texto, botoes) {
      const teclado = paraBotoes(botoes);
      try {
        await bot.api.sendMessage(conversa, texto, {
          parse_mode: 'HTML',
          ...(teclado ? { reply_markup: teclado } : {}),
        });
      } catch (err: any) {
        if (err?.message?.includes("can't parse entities") || err?.description?.includes("can't parse entities")) {
          console.warn('⚠ Erro de parsing HTML no Telegram, a enviar como texto limpo');
          await bot.api.sendMessage(conversa, texto.replace(/<[^>]+>/g, ''), {
            ...(teclado ? { reply_markup: teclado } : {}),
          });
        } else {
          throw err;
        }
      }
    },

    async enviarDocumento(conversa, doc, legenda, botoes) {
      const teclado = paraBotoes(botoes);
      let arquivo: InputFile;
      if (doc.caminho) {
        arquivo = new InputFile(doc.caminho, doc.nome);
      } else if (doc.buffer) {
        arquivo = new InputFile(doc.buffer, doc.nome);
      } else {
        arquivo = new InputFile(Buffer.from(doc.conteudoTexto ?? '', 'utf-8'), doc.nome);
      }
      try {
        await bot.api.sendDocument(conversa, arquivo, {
          caption: legenda,
          parse_mode: 'HTML',
          ...(teclado ? { reply_markup: teclado } : {}),
        });
      } catch (err: any) {
        console.warn('⚠ Erro ao enviar documento via bot.api.sendDocument:', err?.message ?? err);
        await bot.api.sendMessage(
          conversa,
          `${legenda ?? ''}\n\n📄 <b>${doc.nome}</b>:\n<pre>${(doc.conteudoTexto ?? '').slice(0, 3500)}</pre>`,
          {
            parse_mode: 'HTML',
            ...(teclado ? { reply_markup: teclado } : {}),
          },
        ).catch(() => {});
      }
    },

    async enviarSequencia(conversa, mensagens, botoes, aoEnviar) {
      if (!mensagens || mensagens.length === 0) return;
      for (let i = 0; i < mensagens.length; i++) {
        const msg = mensagens[i];
        const eUltima = i === mensagens.length - 1;
        const teclado = eUltima ? paraBotoes(botoes) : undefined;

        if (i > 0) {
          // Pequena pausa natural entre balões consecutivos (sem re-disparar typing no Telegram)
          const pausa = Math.min(450, Math.max(180, Math.floor(msg.length * 4)));
          await new Promise((r) => setTimeout(r, pausa));
        }

        try {
          await bot.api.sendMessage(conversa, msg, {
            parse_mode: 'HTML',
            ...(teclado ? { reply_markup: teclado } : {}),
          });
        } catch (err: any) {
          if (err?.message?.includes("can't parse entities") || err?.description?.includes("can't parse entities")) {
            console.warn('⚠ Erro de parsing HTML no Telegram (sequência), a enviar como texto limpo');
            await bot.api.sendMessage(conversa, msg.replace(/<[^>]+>/g, ''), {
              ...(teclado ? { reply_markup: teclado } : {}),
            });
          } else {
            throw err;
          }
        }

        if (aoEnviar) {
          await aoEnviar(msg, eUltima);
        }
      }
    },

    async editar(conversa, mensagem, texto, botoes) {
      const teclado = paraBotoes(botoes);
      await bot.api.editMessageText(conversa, mensagem, texto, {
        parse_mode: 'HTML',
        ...(teclado ? { reply_markup: teclado } : {}),
      });
    },

    async aEscrever(conversa) {
      await bot.api.sendChatAction(Number(conversa), 'typing');
    },

    async parar() {
      await bot.stop();
    },

    /** Só para o ponto de entrada de testes. */
    _aoReceber(f: AoReceber) {
      aoReceber = f;
    },

    /** O bot cru, para o modo webhook (Vercel) processar atualizações. */
    _bot() {
      return bot;
    },
  };
}

/** Contexto cru, só para o que ainda não cabia na interface. */
export type ContextoTelegram = Context;
/**
 * O kernel do núcleo: a fiação completa do representante, pronta a usar
 * tanto pelo processo local (principal.ts) como pelas funções serverless
 * (api/ no Vercel).
 *
 * Aqui vive a regra que importa: Telegram e painel são DOIS CANAIS do mesmo
 * cérebro. O canal faz fan-out — regista no barramento (painel, auditoria) e
 * envia ao Telegram (best-effort) — e o tratador é um só.
 */
import { criarCanalGrammy, type CanalGrammy, type Botoes, type MensagemRecebida } from './canal.ts';
import { SESSAO, URL_BASE_EXTERNA, type Base } from './bd.ts';
import type { Registo } from './eventos/registo.ts';
import { criarTratadorMensagens, type EstadoCanalPartilhado } from './canal/tratador-mensagens.ts';
import { Henriques } from './henriques/henriques.ts';
import { Henriques } from './henriques/henriques.ts';
import { RedatorOpenRouter } from './henriques/redator-openrouter.ts';
import { MotorDecisaoTypeSafe } from './typesafe/motor-decisao.ts';
import { ClientePortaMcp } from './henriques/cliente-porta.ts';
import { BuscadorConhecimento } from './conhecimento/buscador.ts';
import { CofreDigital } from './cofre/cofre.ts';
import { ServicoChavesCofre } from './cofre/servico-chaves.ts';
import { GestorMandatos } from './mandatos/mandatos.ts';
import { MotorPolitica } from './politica/politica.ts';
import { OrquestradorMissoes } from './orquestrador/missao.ts';
import { GestorFluxoD2 } from './orquestrador/fluxo-conversa-d2.ts';
import { ProcessadorCenarios } from './simuladores/cenarios.ts';
import { TratadorComandos } from './comandos/tratador-comandos.ts';
import type { EntradaCanalWeb, LigacaoWeb } from './eventos/servidor.ts';
import { randomBytes } from 'node:crypto';

export const PESSOA_PADRAO = 'pessoa-1bbe89cb4d';

export interface DependenciasKernel {
  base: Base;
  /** Token do bot. Sem token, o Telegram fica em modo nulo (só painel). */
  tokenTelegram?: string | null;
  /** Modo de teste do canal web: códigos de ligação ficam ligados por omissão. */
  canalWebAutoLigar?: boolean;
  /** Chamado quando uma mensagem associa uma pessoa a uma conversa (persistência local). */
  aoAssociarConversa?: (pessoa: string, conversa: string) => void;
  /** Redator alternativo (testes). */
  redator?: RedatorOpenRouter;
  /** Motor de decisão alternativo (testes). */
  motorDecisao?: MotorDecisaoTypeSafe;
}

export interface Kernel {
  base: Base;
  registro: Registo;
  canal: CanalGrammy;
  canalTelegram: CanalGrammy;
  henriques: Henriques;
  cofre: CofreDigital;
  mandatos: GestorMandatos;
  orquestrador: OrquestradorMissoes;
  fluxoD2: GestorFluxoD2;
  cenarios: ProcessadorCenarios;
  comandos: TratadorComandos;
  clientePorta: ClientePortaMcp;
  buscador: BuscadorConhecimento;
  conversasPorPessoa: Map<string, string>;
  estado: EstadoCanalPartilhado;
  tratar: (m: MensagemRecebida) => Promise<void>;
  aoReceberCanalWeb: (entrada: EntradaCanalWeb) => Promise<void>;
  criarLigacaoWeb: () => string;
  obterLigacaoWeb: (codigo: string) => LigacaoWeb | null;
  obterPedidosConsola: () => Promise<any[]>;
  /** Notifica o cidadão de alterações do SU ainda não despachadas (modo alojado). */
  despacharNotificacoesSU: () => Promise<void>;
}

const canalNulo: CanalGrammy = {
  async ligar() {
    throw new Error('Telegram desativado (sem token)');
  },
  async enviar() {
    console.warn('⚠ Telegram desativado: mensagem só no painel e no registo');
  },
  async enviarSequencia() {
    console.warn('⚠ Telegram desativado: mensagem só no painel e no registo');
  },
  async enviarDocumento() {
    console.warn('⚠ Telegram desativado: documento só no painel e no registo');
  },
  async editar() {},
  async aEscrever() {},
  async parar() {},
  _aoReceber() {},
};

export async function criarKernel(deps: DependenciasKernel): Promise<Kernel> {
  const { base } = deps;

  const conversasPorPessoa = new Map<string, string>();
  if (!conversasPorPessoa.has(PESSOA_PADRAO)) conversasPorPessoa.set(PESSOA_PADRAO, '5361126841');

  const estadoCanal: EstadoCanalPartilhado = { ultimaConversa: '5361126841', aguardaFachada: false };

  const registro = new Registo(base.escrita as never);

  const canalTelegram: CanalGrammy = deps.tokenTelegram
    ? criarCanalGrammy(deps.tokenTelegram)
    : canalNulo;

  const pessoaDaConversa = (conversa: string): string | null =>
    [...conversasPorPessoa].find(([, c]) => c === conversa)?.[0] ?? null;

  function serializarBotoes(botoes?: Botoes) {
    return botoes?.map((linha) => linha.map((b) => ({ texto: b.texto, dados: b.dados ?? null }))) ?? [];
  }

  async function registarMensagemEnviada(
    conversa: string,
    dados: { texto: string; documento?: { nome: string }; botoes: Array<{ texto: string; dados: string | null }[]> },
  ): Promise<void> {
    await registro
      .registar({
        tipo: 'canal.mensagem.enviada',
        origem: 'canal',
        sessao: SESSAO,
        pessoa: pessoaDaConversa(conversa),
        missao: null,
        ator: 'agente:henriques',
        simulacao: false,
        dados: { ...dados, entregue_no_canal: true },
      })
      .catch((err: unknown) => console.warn('⚠ envio sem registo:', err));
  }

  const canal: CanalGrammy = {
    ...canalTelegram,
    async enviar(conversa, texto, botoes) {
      await registarMensagemEnviada(conversa, { texto, botoes: serializarBotoes(botoes) });
      try {
        await canalTelegram.enviar(conversa, texto, botoes);
      } catch (err: any) {
        console.warn('⚠ Telegram indisponível (resposta entregue no painel e no registo):', err?.message ?? err);
      }
    },
    async enviarSequencia(conversa, mensagens, botoes) {
      for (let i = 0; i < mensagens.length; i++) {
        await registarMensagemEnviada(conversa, {
          texto: mensagens[i],
          botoes: i === mensagens.length - 1 ? serializarBotoes(botoes) : [],
        });
      }
      try {
        await canalTelegram.enviarSequencia(conversa, mensagens, botoes);
      } catch (err: any) {
        console.warn('⚠ Telegram indisponível (sequência entregue no painel e no registo):', err?.message ?? err);
      }
    },
    async enviarDocumento(conversa, doc, legenda, botoes) {
      await registarMensagemEnviada(conversa, {
        texto: legenda ?? `Documento: ${doc.nome}`,
        documento: { nome: doc.nome },
        botoes: serializarBotoes(botoes),
      });
      try {
        await canalTelegram.enviarDocumento(conversa, doc, legenda, botoes);
      } catch (err: any) {
        console.warn('⚠ Telegram indisponível (documento entregue no painel e no registo):', err?.message ?? err);
      }
    },
  };

  const redator = deps.redator ?? new RedatorOpenRouter();
  const clientePorta = new ClientePortaMcp(process.env.PORTA_MCP_URL || undefined);
  const buscador = new BuscadorConhecimento();
  const henriques = new Henriques(registro, clientePorta, SESSAO, deps.motorDecisao, redator, buscador);

  const servicoChaves = new ServicoChavesCofre(registro, SESSAO);
  const cofre = new CofreDigital(registro, servicoChaves, SESSAO);
  const mandatos = new GestorMandatos(registro, SESSAO);
  const politica = new MotorPolitica(registro, mandatos, SESSAO);
  const orquestrador = new OrquestradorMissoes(registro, SESSAO);

  const fluxoD2 = new GestorFluxoD2({
    cofre,
    mandatos,
    orquestrador,
    registo: registro,
    canal,
    sessao: SESSAO,
    redator,
  });

  const cenarios = new ProcessadorCenarios({
    mandatos,
    cofre,
    politica,
    servicoChaves,
    clientePorta,
    orquestrador,
    registo: registro,
    canal,
    obterChat: (pessoa: string) => conversasPorPessoa.get(pessoa) ?? estadoCanal.ultimaConversa,
    sessao: SESSAO,
  });

  const comandos = new TratadorComandos({
    canal,
    cofre,
    mandatos,
    orquestrador,
    registo: registro,
    sessao: SESSAO,
    henriques,
    fluxoD2,
  });

  // ── Ligações de sessões Web (painel ↔ Telegram) ────────────────────────
  const ligacoesWeb = new Map<string, LigacaoWeb>();

  function criarLigacaoWeb(): string {
    const codigo = randomBytes(16).toString('hex');
    if (deps.canalWebAutoLigar) {
      ligacoesWeb.set(codigo, {
        pessoa: PESSOA_PADRAO,
        conversa: conversasPorPessoa.get(PESSOA_PADRAO) ?? estadoCanal.ultimaConversa ?? '5361126841',
        quando: new Date().toISOString(),
      });
      console.log('🔗 [Canal Web] ligação automática à pessoa de demonstração');
    }
    return codigo;
  }

  function obterLigacaoWeb(codigo: string): LigacaoWeb | null {
    return ligacoesWeb.get(codigo.toLowerCase()) ?? null;
  }

  const tratarCanal = criarTratadorMensagens({
    canal,
    registro,
    sessao: SESSAO,
    henriques,
    comandos,
    fluxoD2,
    cenarios,
    cofre,
    mandatos,
    orquestrador,
    clientePorta,
    consultarEventos: (sql) => base.escrita.query(sql) as never,
    obterPedidosConsola: () => obterPedidosConsola(),
    conversasPorPessoa,
    estado: estadoCanal,
    aoAssociarConversa: deps.aoAssociarConversa,
    aoLigarPessoa: (codigo, m) => {
      ligacoesWeb.set(codigo, { pessoa: m.pessoa, conversa: m.conversa, quando: new Date().toISOString() });
      console.log(`🔗 [Canal Web] Sessão ligada a ${m.pessoa} (código ${codigo.slice(0, 8)}…)`);
    },
  });

  let filaCanalWeb: Promise<void> = Promise.resolve();

  async function aoReceberCanalWeb(entrada: EntradaCanalWeb): Promise<void> {
    const ligacao = obterLigacaoWeb(entrada.codigo);
    if (!ligacao) {
      throw new Error('Sessão não ligada: faça /start no Telegram com o código do painel');
    }
    const m: MensagemRecebida = {
      pessoa: ligacao.pessoa,
      tipo: entrada.botao ? 'botao' : (entrada.texto as string).startsWith('/') ? 'comando' : 'texto',
      texto: entrada.botao ?? entrada.texto ?? null,
      foto: null,
      documento: null,
      conversa: ligacao.conversa,
      quando: new Date().toISOString(),
    };
    const tarefa = filaCanalWeb.then(() => tratarCanal.tratar(m));
    filaCanalWeb = tarefa.catch(() => {});
    await tarefa;
  }

  // ── Consola: pedidos do dia (reais + demonstração) ──────────────────────
  async function obterPedidosConsola(): Promise<any[]> {
    const casosMap = new Map<string, any>();
    try {
      const resEventos = await base.escrita.query(
        "SELECT seq, tipo, dados, ts FROM nucleo.eventos WHERE tipo IN ('consola.caso.criado', 'consola.caso.despachado', 'consola.elemento.solicitado') ORDER BY seq ASC",
      );
      for (const row of resEventos.rows) {
        const d = row.dados || {};
        const processo = d.processo || 'OEP/2026/0001';
        if (row.tipo === 'consola.caso.criado') {
          let estab = d.estabelecimento || 'Estabelecimento Comercial';
          let morada = d.morada || 'Guimarães';
          if (estab && morada.toLowerCase().startsWith(estab.toLowerCase())) {
            morada = morada.slice(estab.length).replace(/^[,\s-]+/, '').trim();
          }
          const numMesas = d.mesas || 4;
          const area = d.area_m2 || numMesas * 2.5;
          casosMap.set(processo, {
            id: `CASO-${processo.replace(/[/]/g, '-')}`,
            processo,
            codigo: `#${processo.replace(/[/]/g, '-')}`,
            titulo: 'Ocupação do espaço público · Esplanada aberta',
            servico: 'Espaço Público (OVP-SO)',
            hora: new Date(row.ts).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }),
            status: 'Aguarda análise',
            tagClass: 'tag wait',
            resumo: `Avaliar instalação de esplanada aberta no estabelecimento ${estab}.`,
            dados: [
              { campo: 'Processo Municipal', valor: processo },
              { campo: 'Serviço', valor: 'Mera Comunicação Prévia (Artigo 8.º ROPP)' },
              { campo: 'Estabelecimento', valor: estab },
              { campo: 'Local de intervenção', valor: morada },
              { campo: 'Área e Instalação', valor: `${area} m² · ${numMesas} Mesas e ${numMesas * 2} Cadeiras` },
              { campo: 'Corredor Pedonal', valor: d.largura_livre || '2,50 metros (cumpre Art. 8.º >= 2,00 m)' },
              { campo: 'Assinatura Digital', valor: d.token_cmd ? `Chave Móvel Digital (${d.token_cmd})` : 'Chave Móvel Digital (Mandato D3)' },
            ],
            omitidos: ['Conversa completa', 'NIF e Contacto direto', 'Faturamento do restaurante', 'IBAN', 'Situação fiscal'],
          });
        } else if (row.tipo === 'consola.caso.despachado') {
          const caso = casosMap.get(processo);
          if (caso) {
            caso.status = d.decisao === 'aprovado' ? 'Aprovada' : 'Indeferida';
            caso.tagClass = d.decisao === 'aprovado' ? 'tag ok' : 'tag refused';
          }
        } else if (row.tipo === 'consola.elemento.solicitado') {
          const caso = casosMap.get(processo);
          if (caso) {
            caso.status = 'Aguarda documentos';
            caso.tagClass = 'tag wait';
          }
        }
      }
    } catch {}

    const listaCasosReais = Array.from(casosMap.values()).reverse();
    if (listaCasosReais.length === 0) {
      listaCasosReais.push({
        id: 'CASO-0001',
        processo: 'OEP/2026/0001',
        codigo: '#OEP-0001',
        titulo: 'Ocupação do espaço público · Esplanada aberta',
        servico: 'Espaço Público (OVP-SO)',
        hora: '10:42',
        status: 'Aprovada',
        tagClass: 'tag ok',
        resumo: 'Avaliar instalação de esplanada aberta no estabelecimento Cafe da beira.',
        dados: [
          { campo: 'Processo Municipal', valor: 'OEP/2026/0001' },
          { campo: 'Serviço', valor: 'Mera Comunicação Prévia (Artigo 8.º ROPP)' },
          { campo: 'Estabelecimento', valor: 'Cafe da beira' },
          { campo: 'Local de intervenção', valor: 'Rua de São José, Guimarães' },
          { campo: 'Área e Instalação', valor: '10 m² · 4 Mesas e 8 Cadeiras' },
          { campo: 'Corredor Pedonal', valor: '2,50 metros (cumpre Art. 8.º >= 2,00 m)' },
          { campo: 'Assinatura Digital', valor: 'Chave Móvel Digital (CMD-TOKEN-977816)' },
        ],
        omitidos: ['Conversa completa', 'NIF e Contacto direto', 'Faturamento do restaurante', 'IBAN', 'Situação fiscal'],
      });
    }

    return [
      ...listaCasosReais,
      {
        id: 'CASO-PIP-2026-0002',
        processo: 'PIP/2026/0002',
        codigo: '#PIP-0002',
        titulo: 'Pedido de Informação Prévia (PIP) · Viabilidade PDM',
        servico: 'Gestão Urbanística (Art. 14.º RJUE)',
        hora: '10:18',
        status: 'Aguarda análise',
        tagClass: 'tag wait',
        resumo: 'Apreciação prévia vinculativa de viabilidade de construção de moradia unifamiliar em Silvares.',
        dados: [
          { campo: 'Processo Municipal', valor: 'PIP/2026/0002' },
          { campo: 'Localização do Terreno', valor: 'Silvares, Guimarães (41.4425, -8.2918)' },
          { campo: 'Classificação no PDM', valor: 'Solo Urbano · Espaço Residencial Nível 2' },
          { campo: 'Caderneta Predial', valor: 'Artigo Matricial 1420 (Silvares, Guimarães)' },
          { campo: 'Assinatura Digital', valor: 'Chave Móvel Digital (Mandato D3)' },
        ],
        omitidos: ['Conversa completa', 'Restante património imobiliário', 'Dados bancários'],
      },
      {
        id: 'CASO-EVT-2026-0003',
        processo: 'EVT/2026/0003',
        codigo: '#EVT-0003',
        titulo: 'Autorização para Prova Desportiva na Via Pública',
        servico: 'Divisão de Trânsito e Polícia Municipal',
        hora: '09:54',
        status: 'Aguarda análise',
        tagClass: 'tag wait',
        resumo: 'Licenciamento e parecer para realização da 1.ª Corrida Popular de Azurém (10 Km).',
        dados: [
          { campo: 'Processo Municipal', valor: 'EVT/2026/0003' },
          { campo: 'Percurso Oficial', valor: 'Azurém · Partida: Campus Azurém / Meta: Pista Gémeos Castro' },
          { campo: 'Data do Evento', valor: '15 de Outubro de 2026 (09:30 às 12:30)' },
          { campo: 'Apólice de Seguro', valor: 'N.º 98765432-FID/2026 (Fidelidade Seguros · DL 10/2009)' },
          { campo: 'Termo de Responsabilidade', valor: 'Assinado com declaração de limpeza da via' },
          { campo: 'Assinatura Digital', valor: 'Chave Móvel Digital (Mandato D3)' },
        ],
        omitidos: ['Conversa completa', 'Dados pessoais de atletas inscritos', 'Dados bancários'],
      },
      {
        id: 'CASO-RES-2026-0112',
        processo: 'RES/2026/0112',
        codigo: '#DG-2045',
        titulo: 'Recolha de resíduos volumosos',
        servico: 'Serviços Urbanos e Ambiente',
        hora: '09:32',
        status: 'Resolvida',
        tagClass: 'tag ok',
        resumo: 'Agendamento de recolha de móveis e eletrodomésticos no domicílio.',
        dados: [
          { campo: 'Serviço', valor: 'Recolha de Monstros' },
          { campo: 'Freguesia', valor: 'Creixomil, Guimarães' },
          { campo: 'Tipologia', valor: '2 volumes (sofá e frigorífico)' },
        ],
        omitidos: ['Conversa completa', 'Contacto telefónico'],
      },
    ];
  }

  // ── Notificações do SU sem LISTEN (modo alojado) ────────────────────────
  // Local, o principal escuta o pg_notify. Sem processo vivo, quem serve
  // pedidos do kernel faz o despacho oportunista: marca em nucleo.despachos
  // e entrega ao cidadão pelo canal. Idempotente.
  async function despacharNotificacoesSU(): Promise<void> {
    if (URL_BASE_EXTERNA === null) return; // local: o principal trata disto
    try {
      await base.escrita.query('CREATE TABLE IF NOT EXISTS nucleo.despachos (seq BIGINT PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now())');
      const pendentes = await base.escrita.query(
        `SELECT e.seq, e.pessoa, e.dados
           FROM nucleo.eventos e
           LEFT JOIN nucleo.despachos d ON d.seq = e.seq
          WHERE e.tipo = 'su.processo.estado.alterado' AND d.seq IS NULL
          ORDER BY e.seq ASC LIMIT 10`,
      );
      for (const ev of pendentes.rows) {
        const chat = (ev.pessoa ? conversasPorPessoa.get(ev.pessoa) : null) ?? estadoCanal.ultimaConversa;
        if (chat && ev.dados?.para === 'aceite') {
          const taxa = ev.dados?.taxa?.valor ?? 75.75;
          await canal.enviar(
            chat,
            [
              '✅ <b>Comunicação Prévia Deferida!</b>',
              '',
              'A técnica do Gabinete de Serviços Urbanos <b>aceitou</b> a sua esplanada.',
              `Processo: <code>${ev.dados?.processo ?? 'OEP/2026/0001'}</code> (Simulação)`,
              '',
              `<b>Taxa Municipal:</b> ${Number(taxa).toFixed(2).replace('.', ',')} € (Simulação)`,
              '<i>(O pagamento é efetuado fora do canal, por autonomia e segurança.)</i>',
            ].join('\n'),
          );
        }
        await base.escrita.query('INSERT INTO nucleo.despachos (seq) VALUES ($1) ON CONFLICT DO NOTHING', [ev.seq]);
      }
    } catch (err: any) {
      console.warn('⚠ despacho de notificações SU:', err?.message ?? err);
    }
  }

  return {
    base,
    registro,
    canal,
    canalTelegram,
    henriques,
    cofre,
    mandatos,
    orquestrador,
    fluxoD2,
    cenarios,
    comandos,
    clientePorta,
    buscador,
    conversasPorPessoa,
    estado: estadoCanal,
    tratar: (m) => tratarCanal.tratar(m),
    aoReceberCanalWeb,
    criarLigacaoWeb,
    obterLigacaoWeb,
    obterPedidosConsola,
    despacharNotificacoesSU,
  };
}

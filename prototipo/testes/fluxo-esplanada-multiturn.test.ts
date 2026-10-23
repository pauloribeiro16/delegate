/**
 * Testes do Fluxo Conversacional Multi-Turno da Esplanada, conduzidos pelo
 * tratador de mensagens REAL (canal/tratador-mensagens.ts) — o mesmo código que
 * o Telegram e o painel Web executam. Nada de lógica duplicada no teste.
 *
 * Cobre:
 *   1. O caminho por texto, do D0 ao rascunho concluído e à submissão com CMD;
 *   2. O caminho só por botões (o que o painel Web carrega), do início ao D3;
 *   3. A ligação de uma sessão Web (/start <código>) através do tratador;
 *   4. O isolamento de contexto: duas pessoas em pilhas separadas não misturam
 *      conversas nem estado de rascunho.
 */
import { describe, expect, it } from 'vitest';
import { MotorDecisaoTypeSafe } from '../apps/api/src/nucleo/typesafe/motor-decisao.ts';
import { Henriques } from '../apps/api/src/nucleo/henriques/henriques.ts';
import { ClientePortaMcp } from '../apps/api/src/nucleo/henriques/cliente-porta.ts';
import { RedatorOpenRouter } from '../apps/api/src/nucleo/henriques/redator-openrouter.ts';
import { CofreDigital } from '../apps/api/src/nucleo/cofre/cofre.ts';
import { ServicoChavesCofre } from '../apps/api/src/nucleo/cofre/servico-chaves.ts';
import { GestorMandatos } from '../apps/api/src/nucleo/mandatos/mandatos.ts';
import { OrquestradorMissoes } from '../apps/api/src/nucleo/orquestrador/missao.ts';
import { GestorFluxoD2 } from '../apps/api/src/nucleo/orquestrador/fluxo-conversa-d2.ts';
import { MotorPolitica } from '../apps/api/src/nucleo/politica/politica.ts';
import { ProcessadorCenarios } from '../apps/api/src/nucleo/simuladores/cenarios.ts';
import { TratadorComandos } from '../apps/api/src/nucleo/comandos/tratador-comandos.ts';
import { criarTratadorMensagens } from '../apps/api/src/nucleo/canal/tratador-mensagens.ts';
import type { Registo } from '../apps/api/src/nucleo/eventos/registo.ts';
import type { CanalGrammy, Botoes, MensagemRecebida } from '../apps/api/src/nucleo/canal.ts';

function criarRegistoMock(): { registo: Registo; eventos: Array<{ tipo: string; dados: Record<string, unknown> }> } {
  const eventos: Array<{ tipo: string; dados: Record<string, unknown> }> = [];
  const registo = {
    registar: async (pedido: { tipo: string; dados: Record<string, unknown> }) => {
      eventos.push({ tipo: pedido.tipo, dados: pedido.dados });
      return { seq: eventos.length, hash: `sha256:fake_${eventos.length}`, ...pedido };
    },
    listar: async () => eventos.map((e, idx) => ({ seq: idx + 1, ts: new Date().toISOString(), ...e })),
  } as unknown as Registo;

  return { registo, eventos };
}

class CanalMock implements CanalGrammy {
  mensagens: Array<{ conversa: string; texto: string; botoes?: Botoes }> = [];

  async ligar() {}
  async aEscrever() {}
  async editar() {}
  async parar() {}
  _aoReceber() {}
  _bot(): never {
    throw new Error('sem bot no teste');
  }
  async enviar(conversa: string, texto: string, botoes?: Botoes) {
    this.mensagens.push({ conversa, texto, botoes });
  }
  async enviarSequencia(conversa: string, msgs: string[], botoes?: Botoes) {
    for (let i = 0; i < msgs.length; i++) {
      this.mensagens.push({ conversa, texto: msgs[i], botoes: i === msgs.length - 1 ? botoes : undefined });
    }
  }
  async enviarDocumento(conversa: string, doc: { nome: string }, legenda?: string, botoes?: Botoes) {
    this.mensagens.push({ conversa, texto: legenda ?? `Documento: ${doc.nome}`, botoes });
  }
  ultimaMensagem(): string {
    return this.mensagens[this.mensagens.length - 1]?.texto ?? '';
  }
  mensagensDe(conversa: string): string {
    return this.mensagens.filter((m) => m.conversa === conversa).map((m) => m.texto).join('\n');
  }
}

function criarPilha(pessoa: string, conversa: string) {
  const { registo, eventos } = criarRegistoMock();
  const canal = new CanalMock();
  const porta = new ClientePortaMcp('http://localhost:4001/mcp');
  const redator = new RedatorOpenRouter();
  const henriques = new Henriques(registo, porta, 'demo', new MotorDecisaoTypeSafe(), redator);
  const servicoChaves = new ServicoChavesCofre(registo, 'demo');
  const cofre = new CofreDigital(registo, servicoChaves, 'demo');
  const mandatos = new GestorMandatos(registo, 'demo');
  const orquestrador = new OrquestradorMissoes(registo, 'demo');
  const fluxoD2 = new GestorFluxoD2({
    registo,
    orquestrador,
    mandatos,
    cofre,
    canal: canal as any,
    sessao: 'demo',
    redator,
  });
  const politica = new MotorPolitica(registo, mandatos, 'demo');
  const cenarios = new ProcessadorCenarios({
    mandatos,
    cofre,
    politica,
    servicoChaves,
    clientePorta: porta,
    orquestrador,
    registo,
    canal: canal as any,
    obterChat: () => conversa,
    sessao: 'demo',
  });
  const comandos = new TratadorComandos({
    canal: canal as any,
    cofre,
    mandatos,
    orquestrador,
    registo,
    sessao: 'demo',
    henriques,
    fluxoD2,
  });

  const ligacoes: Array<{ codigo: string; pessoa: string; conversa: string }> = [];
  const tratador = criarTratadorMensagens({
    canal: canal as any,
    registro: registo,
    sessao: 'demo',
    henriques,
    comandos,
    fluxoD2,
    cenarios,
    cofre,
    mandatos,
    orquestrador,
    clientePorta: porta,
    consultarEventos: async () => ({
      rows: eventos.map((e, i) => ({ seq: i + 1, tipo: e.tipo, dados: e.dados, ts: new Date().toISOString() })),
    }),
    obterPedidosConsola: async () => [],
    conversasPorPessoa: new Map([[pessoa, conversa]]),
    estado: { ultimaConversa: conversa, aguardaFachada: false },
    aoLigarPessoa: (codigo, m) => {
      ligacoes.push({ codigo, pessoa: m.pessoa, conversa: m.conversa });
    },
  });

  const texto = (t: string) => tratador.tratar({ pessoa, tipo: t.startsWith('/') ? 'comando' : 'texto', texto: t, foto: null, documento: null, conversa, quando: new Date().toISOString() });
  const botao = (dados: string) => tratador.tratar({ pessoa, tipo: 'botao', texto: dados, foto: null, documento: null, conversa, quando: new Date().toISOString() });

  return { tratador, canal, eventos, cofre, fluxoD2, orquestrador, henriques, ligacoes, texto, botao };
}

describe('Fluxo da esplanada pelo tratador real (o mesmo código do Telegram e do painel)', () => {
  it('caminho por texto: D0 → D2 → morada → mesas → corredor → minuta → submissão CMD', async () => {
    const pilha = criarPilha('paulo_demo_esplanada', 'chat_paulo_123');
    const { canal, cofre, fluxoD2, henriques, texto, botao } = pilha;
    const pessoa = 'paulo_demo_esplanada';

    // ── TURNO 1: pergunta real sobre a esplanada → resposta D0 com fonte
    await texto('Olá Henrique, eu preciso de ajuda em como posso abrir uma esplanada ? Quais são os passos ?');
    const turno1 = canal.mensagens.map((m) => m.texto).join('\n');
    expect(turno1).toContain('esplanada');
    expect(turno1).toContain('2,00');
    expect(turno1).toContain('Regulamento');
    expect(henriques.contexto.obterContexto(pessoa).servicoAtivoId).toBe('ocupacao-espaco-publico-esplanada');

    // ── TURNO 2: "Sim quero" → D2, pergunta a morada uma única vez
    canal.mensagens = [];
    await texto('Sim quero');
    expect(canal.ultimaMensagem()).toContain('Cofre Digital');
    expect(canal.ultimaMensagem()).toContain('Mandato D2');
    expect(canal.ultimaMensagem()).toContain('morada');
    expect(fluxoD2.obterRascunhoAtivo(pessoa)?.estado).toBe('aguarda_morada');

    // ── TURNO 3: a morada → avança para mesas, sem repetir a pergunta
    canal.mensagens = [];
    await texto('Rua de São José, Guimarães');
    const rascunhoAposMorada = fluxoD2.obterRascunhoAtivo(pessoa);
    expect(rascunhoAposMorada?.morada).toBe('Rua de São José, Guimarães');
    expect(rascunhoAposMorada?.estado).toBe('aguarda_mesas');
    expect(canal.ultimaMensagem().toLowerCase()).not.toContain('qual é o nome e a morada');
    expect(canal.ultimaMensagem().toLowerCase()).toContain('mesas');
    const itensCofre = cofre.listarItensCompletos(pessoa);
    expect(itensCofre.some((it: any) => (it.dadosDecifrados as any)?.morada === 'Rua de São José, Guimarães')).toBe(true);

    // ── TURNO 4: "4 mesas" → corredor pedonal
    canal.mensagens = [];
    await texto('4 mesas');
    const rascunhoAposMesas = fluxoD2.obterRascunhoAtivo(pessoa);
    expect(rascunhoAposMesas?.mesas).toBe(4);
    expect(rascunhoAposMesas?.estado).toBe('aguarda_passeio');
    expect(canal.ultimaMensagem()).toContain('2,00');

    // ── TURNO 5: corredor validado → rascunho concluído, minuta e botão CMD
    canal.mensagens = [];
    await texto('Sim, tem 2,5 metros');
    const rascunhoFinal = fluxoD2.obterRascunhoAtivo(pessoa);
    expect(rascunhoFinal?.estado).toBe('concluido');
    expect(rascunhoFinal?.larguraLivre).toBe('2,50 metros');
    expect(canal.ultimaMensagem()).toContain('MINUTA DO REQUERIMENTO MUNICIPAL (OVP-SO)');
    expect(canal.ultimaMensagem()).toContain('Rua de São José, Guimarães');
    expect(canal.ultimaMensagem()).toContain('4 mesas');
    expect(canal.ultimaMensagem()).toContain('2,50 metros');
    const botaoCmd = canal.mensagens.at(-1)?.botoes?.[0]?.[0];
    expect(botaoCmd?.dados).toBe('assinar_com_chave_movel_digital');

    // ── TURNO 6: o botão da Chave Móvel Digital (como chega do painel/Telegram) → D3
    canal.mensagens = [];
    await botao('assinar_com_chave_movel_digital');
    expect(canal.ultimaMensagem()).toContain('Comunicação Prévia Submetida com Sucesso');
    expect(canal.ultimaMensagem()).toContain('OEP/2026/0001');
    expect(canal.ultimaMensagem()).toContain('Mandato D3');

    // O caso chegou à Consola Municipal com os dados reais recolhidos
    const eventosConsola = pilha.eventos.filter(
      (e) => e.tipo === 'consola.caso.criado' && (e.dados as any).processo === 'OEP/2026/0001',
    );
    const ultimo = eventosConsola.at(-1);
    expect(ultimo).toBeDefined();
    expect((ultimo!.dados as any).morada).toBe('Rua de São José, Guimarães');
    expect((ultimo!.dados as any).mesas).toBe(4);
  });

  it('caminho só por botões: D0 → iniciar_esplanada → d2_morada → d2_mesas → d2_anexar_todos → CMD', async () => {
    const pilha = criarPilha('ines_botoes', 'chat_ines_botoes');
    const { canal, cofre, fluxoD2, orquestrador, texto, botao } = pilha;
    const pessoa = 'ines_botoes';

    // A resposta D0 oferece o botão de iniciar — é o que o painel mostra clicável
    await texto('Olá! Como posso abrir uma esplanada?');
    const dadosDosBotoes = canal.mensagens.flatMap((m) => (m.botoes ?? []).flat()).map((b) => b.dados);
    expect(dadosDosBotoes).toContain('iniciar_esplanada');

    // Todo o diálogo seguinte é por botões, como no painel Web
    await botao('iniciar_esplanada');
    expect(fluxoD2.obterRascunhoAtivo(pessoa)?.estado).toBe('aguarda_morada');
    expect(canal.ultimaMensagem()).toContain('nome</b> e a <b>morada');

    await botao('d2_morada_joaquim');
    const rascunho1 = fluxoD2.obterRascunhoAtivo(pessoa);
    expect(rascunho1?.estabelecimento).toBe('Casa Joaquim');
    expect(rascunho1?.morada).toBe('Largo da Oliveira, 12, Guimarães');
    expect(rascunho1?.estado).toBe('aguarda_mesas');

    await botao('d2_mesas_4');
    const rascunho2 = fluxoD2.obterRascunhoAtivo(pessoa);
    expect(rascunho2?.mesas).toBe(4);
    expect(rascunho2?.estado).toBe('aguarda_passeio');
    expect(canal.ultimaMensagem()).toContain('Planta de Implantação / Croquis Cotado');

    await botao('d2_anexar_todos');
    const rascunhoFinal = fluxoD2.obterRascunhoAtivo(pessoa);
    expect(rascunhoFinal?.estado).toBe('concluido');
    expect(rascunhoFinal?.larguraLivre).toBe('2,10 metros');
    expect(canal.ultimaMensagem()).toContain('Documentação Recebida e Auditada pelo Henriques');
    expect(canal.ultimaMensagem()).toContain('Chave Móvel Digital');

    // A auditoria ficou no Cofre e a checklist da missão avançou
    const itensCofre = cofre.listarItensCompletos(pessoa);
    expect(itensCofre.some((it: any) => it.tipo === 'planta_cotada')).toBe(true);
    expect(itensCofre.some((it: any) => it.tipo === 'certidao_comercial')).toBe(true);
    expect(itensCofre.some((it: any) => it.tipo === 'termo_responsabilidade')).toBe(true);
    const missao = orquestrador.obterAtiva(pessoa);
    expect(missao?.checklist.find((p) => p.id === 'chk-3')?.feito).toBe(true);

    // E a submissão final também é um botão
    canal.mensagens = [];
    await botao('assinar_com_chave_movel_digital');
    expect(canal.ultimaMensagem()).toContain('Comunicação Prévia Submetida com Sucesso');
  });

  it('o /start com código de ligação associa a sessão Web à pessoa que chegou', async () => {
    const pilha = criarPilha('pessoa-telegram-xyz', 'chat_xyz');
    const { canal, ligacoes, texto } = pilha;

    const codigo = 'a1b2c3d4e5f60718';
    await texto(`/start ${codigo}`);

    expect(ligacoes).toHaveLength(1);
    expect(ligacoes[0]).toEqual({ codigo, pessoa: 'pessoa-telegram-xyz', conversa: 'chat_xyz' });
    // O /start continuou a produzir a apresentação normal do Henriques
    expect(canal.mensagens.length).toBeGreaterThan(0);
  });

  it('duas pessoas em paralelo não misturam conversas nem rascunhos', async () => {
    const a = criarPilha('pessoa_a', 'chat_a');
    const b = criarPilha('pessoa_b', 'chat_b');

    await a.texto('Quero preparar o processo de esplanada');
    await b.texto('Vamos iniciar o pedido de esplanada');
    expect(a.fluxoD2.obterRascunhoAtivo('pessoa_a')?.estado).toBe('aguarda_morada');
    expect(b.fluxoD2.obterRascunhoAtivo('pessoa_b')?.estado).toBe('aguarda_morada');

    await a.texto('Café Central na Rua de São José, Guimarães');
    await b.texto('Casa do Parque na Avenida de Portugal, Guimarães');
    expect(a.fluxoD2.obterRascunhoAtivo('pessoa_a')?.estabelecimento).toBe('Café Central');
    expect(b.fluxoD2.obterRascunhoAtivo('pessoa_b')?.estabelecimento).toBe('Casa do Parque');

    await a.texto('2 mesas');
    await b.texto('6 mesas');
    await a.texto('temos 2,5 metros de calçada livre');
    await b.texto('temos 2,3 metros de calçada livre');

    const ra = a.fluxoD2.obterRascunhoAtivo('pessoa_a');
    const rb = b.fluxoD2.obterRascunhoAtivo('pessoa_b');
    expect(ra?.estado).toBe('concluido');
    expect(rb?.estado).toBe('concluido');
    expect(ra?.mesas).toBe(2);
    expect(rb?.mesas).toBe(6);

    // A minuta de cada um só fala do seu estabelecimento e da sua morada
    const minutaA = a.canal.mensagensDe('chat_a');
    const minutaB = b.canal.mensagensDe('chat_b');
    expect(minutaA).toContain('Café Central');
    expect(minutaA).toContain('Rua de São José, Guimarães');
    expect(minutaA).not.toContain('Casa do Parque');
    expect(minutaA).not.toContain('Avenida de Portugal');
    expect(minutaB).toContain('Casa do Parque');
    expect(minutaB).toContain('Avenida de Portugal, Guimarães');
    expect(minutaB).not.toContain('Café Central');
    expect(minutaB).not.toContain('Rua de São José');
  });
});

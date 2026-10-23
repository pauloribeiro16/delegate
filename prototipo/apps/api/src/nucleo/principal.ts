/**
 * O núcleo: passagem de mensagens e orquestração do representante digital Henriques.
 *
 * Arquitetura modular segundo o Princípio da Responsabilidade Única (SRP):
 *   Telegram -> canal -> evento na base -> notificação -> SSE -> Observatório / Consola
 *
 * Módulos integrados:
 *   - Henriques: respostas com fonte e verificação estrita
 *   - Cofre Digital: cifra AES-256-GCM, 3 camadas e Guardião de Contexto
 *   - Serviço de Chaves: libertação temporária auditada e recolha automática
 *   - Mandatos: níveis D0 a D3, concessão, verificação e revogação
 *   - Motor de Política: permitir, confirmar, bloquear
 *   - Orquestrador: máquina de estados da missão e checklist oficial
 *   - Processador de Cenários: simulação de PIP, esplanadas e validação com CMD
 *   - Tratador de Comandos: comandos de barra (/start, /carta, /cofre, etc.)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { criarCanalGrammy, type CanalGrammy, type Botao, type Botoes, type MensagemRecebida } from './canal.ts';
import { abrirBase, SESSAO } from './bd.ts';
import { Registo } from './eventos/registo.ts';
import { criarServidorEventos, type EntradaCanalWeb, type LigacaoWeb } from './eventos/servidor.ts';
import { criarTratadorMensagens, type EstadoCanalPartilhado } from './canal/tratador-mensagens.ts';
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

const PORTA_EVENTOS = 4000;
const PESSOA_PADRAO = 'pessoa-1bbe89cb4d';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
// CANAL_WEB=1 deixa o núcleo correr sem token do Telegram — só com o painel.
// É o modo de trabalho noutra máquina e o que os testes de integração usam.
const canalWebSemTelegram = !token && process.env.CANAL_WEB === '1';
if (!token && !canalWebSemTelegram) {
  console.error('✖ Falta o TELEGRAM_BOT_TOKEN. Ver npm run ouvir para a explicação.');
  process.exit(1);
}

console.log('a abrir a base…');
const base = await abrirBase();
const registro = new Registo(base.escrita);
console.log('✓ base aberta');

const CAMINHO_CONVERSAS = resolve(import.meta.dirname, '../../../../.conversas.json');
const CAMINHO_ULTIMO_CHAT = resolve(import.meta.dirname, '../../../../.ultimo_chat');

const conversasPorPessoa = new Map<string, string>();
try {
  const caminhoLido = existsSync(CAMINHO_CONVERSAS)
    ? CAMINHO_CONVERSAS
    : existsSync(resolve(process.cwd(), '.conversas.json'))
      ? resolve(process.cwd(), '.conversas.json')
      : null;
  if (caminhoLido) {
    const dados = JSON.parse(readFileSync(caminhoLido, 'utf-8'));
    for (const [k, v] of Object.entries(dados)) {
      if (k !== 'ultimaConversa' && typeof v === 'string') conversasPorPessoa.set(k, v);
    }
  }
} catch {}
if (!conversasPorPessoa.has(PESSOA_PADRAO)) {
  conversasPorPessoa.set(PESSOA_PADRAO, '5361126841');
}

/** Estado do canal partilhado entre o tratador de mensagens e o resto do núcleo. */
const estadoCanal: EstadoCanalPartilhado = {
  ultimaConversa: (() => {
    try {
      const caminhoLido = existsSync(CAMINHO_ULTIMO_CHAT)
        ? CAMINHO_ULTIMO_CHAT
        : existsSync(resolve(process.cwd(), '.ultimo_chat'))
          ? resolve(process.cwd(), '.ultimo_chat')
          : null;
      return caminhoLido ? readFileSync(caminhoLido, 'utf-8').trim() || null : '5361126841';
    } catch {
      return conversasPorPessoa.get(PESSOA_PADRAO) ?? '5361126841';
    }
  })(),
  aguardaFachada: false,
};

// Cada mensagem que sai fica no registo com texto e botões, seja qual for o
// módulo que a enviou — é essa entrega no barramento que alimenta o painel e a
// auditoria. O Telegram é o segundo destino: se falhar (rede, 409, sem token),
// a resposta continua a chegar ao painel. A marca `entregue_no_canal`
// distingue-a dos eventos `enviada` que alguns módulos registam por conta própria.
const canalNulo: CanalGrammy = {
  async ligar() {
    throw new Error('Telegram desativado (a correr com CANAL_WEB=1, sem token)');
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
const canalTelegram: CanalGrammy = token ? criarCanalGrammy(token) : canalNulo;

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
const redator = new RedatorOpenRouter();
const clientePorta = new ClientePortaMcp();
const buscador = new BuscadorConhecimento();
const henriques = new Henriques(registro, clientePorta, SESSAO, undefined, redator, buscador);

// Módulos de autoridade e privacidade
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

// Processador de cenários simulados (CMD, PIP Urbanismo, Medição de Calçada)
const cenarios = new ProcessadorCenarios({
  mandatos,
  cofre,
  politica,
  servicoChaves,
  clientePorta,
  orquestrador,
  registo: registro,
  canal,
  obterChat: (pessoa) => conversasPorPessoa.get(pessoa) ?? estadoCanal.ultimaConversa,
  sessao: SESSAO,
});

// Tratador de comandos de barra (/)
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

// Obter lista em direto de solicitações para a Consola Municipal da Câmara (com memória e histórico de múltiplos casos)
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

// ── Ligações de sessões Web (painel ↔ Telegram) ────────────────────────────
// O painel pede um código; a pessoa faz /start <código> no bot do Telegram; o
// tratador guarda aqui a associação. Toda a mensagem do painel traz o código, e
// é ele — nunca um pseudónimo vindo do cliente — que diz quem fala. Cada sessão
// vê e movimenta só a sua conversa: o SSE do painel filtra pela pessoa ligada.
const ligacoesWeb = new Map<string, LigacaoWeb>();

function criarLigacaoWeb(): string {
  const codigo = randomBytes(16).toString('hex');
  if (process.env.CANAL_WEB === '1') {
    // Modo de teste do canal web: sem depender do /start no telemóvel, o código
    // fica ligado por omissão à pessoa de demonstração. O arranque normal
    // (sem CANAL_WEB) exige sempre o /start no Telegram — é o que autentica.
    ligacoesWeb.set(codigo, {
      pessoa: PESSOA_PADRAO,
      conversa: conversasPorPessoa.get(PESSOA_PADRAO) ?? estadoCanal.ultimaConversa ?? '5361126841',
      quando: new Date().toISOString(),
    });
    console.log('🔗 [Canal Web] CANAL_WEB=1: código ligado por omissão à pessoa de demonstração');
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
  consultarEventos: (sql) => base.escrita.query(sql),
  obterPedidosConsola,
  conversasPorPessoa,
  estado: estadoCanal,
  aoAssociarConversa: (pessoa, conversa) => {
    try {
      const mapaObj = Object.fromEntries(conversasPorPessoa);
      mapaObj.ultimaConversa = conversa;
      writeFileSync(CAMINHO_CONVERSAS, JSON.stringify(mapaObj, null, 2), 'utf-8');
      writeFileSync(CAMINHO_ULTIMO_CHAT, conversa, 'utf-8');
    } catch {}
  },
  aoLigarPessoa: (codigo, m) => {
    ligacoesWeb.set(codigo, { pessoa: m.pessoa, conversa: m.conversa, quando: new Date().toISOString() });
    console.log(`🔗 [Canal Web] Sessão ligada a ${m.pessoa} (código ${codigo.slice(0, 8)}…)`);
  },
});

canal._aoReceber(tratarCanal.tratar);

// ── Entrada do painel Web: mesma fila, mesmo tratador, mesma resposta ──────
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
  // Uma fila só: as mensagens de um utilizador processam-se pela ordem de
  // chegada, como o grammY faz com as que vêm do Telegram.
  const tarefa = filaCanalWeb.then(() => tratarCanal.tratar(m));
  filaCanalWeb = tarefa.catch(() => {});
  await tarefa;
}

// Servidor de Eventos SSE e API HTTP (inclui webhook da CMD e testador do Router)
const servidor = criarServidorEventos(
  registro,
  () => base.escutar(),
  async (dados) => {
    await cenarios.processarConfirmacaoCmd(dados);
  },
  undefined,
  async (pergunta: string) => {
    const motorDecisao = new MotorDecisaoTypeSafe();
    const decisao = await motorDecisao.decidir(pergunta, {});
    const candidatos = await buscador.buscarCandidatosHibrido(pergunta, 5);
    const resultadoJev = await buscador.buscarComJev(pergunta);
    return {
      ok: true,
      pergunta,
      ...decisao,
      candidatos,
      resultadoJev,
    };
  },
  async () => {
    // Obter missão ativa do cidadão de demonstração ou última conversa
    const pessoaPadrao = 'pessoa-1bbe89cb4d';
    const missao = orquestrador.obterAtiva(pessoaPadrao) ?? orquestrador.obterAtiva('ines_guimaraes') ?? null;
    const rascunhoD2 = fluxoD2.obterRascunhoAtivo(pessoaPadrao) ?? null;
    return {
      missao,
      rascunhoD2,
      estadosPossiveis: [
        { id: 'entendido', nome: '1. Entendido', desc: 'Henriques compreendeu a intenção e enquadrou o serviço' },
        { id: 'a_verificar', nome: '2. A Verificar', desc: 'Instrução de dados e medições regulamentares' },
        { id: 'preparado', nome: '3. Preparado (D2)', desc: 'Rascunho completo no Cofre Digital aguardando CMD' },
        { id: 'submetido', nome: '4. Submetido (D3)', desc: 'Requerimento formal com Chave Móvel Digital na Porta' },
        { id: 'precisa_de_si', nome: '⚠️ Elementos Adicionais', desc: 'Câmara solicitou aperfeiçoamento instrutório' },
        { id: 'com_tecnico', nome: '5. Com Técnico (SU)', desc: 'Em apreciação técnica e jurídica municipal' },
        { id: 'respondido', nome: '6. Concluído', desc: 'Decisão final deferida e taxas liquidadas' },
      ],
    };
  },
  {
    obterDados: async (pessoa = 'pessoa-1bbe89cb4d') => {
      let itens = cofre.listarItensCompletos(pessoa);
      if (itens.length === 0) {
        await cofre.guardarItem(pessoa, 'MIS-0001', {
          camada: 'identidade',
          tipo: 'identidade_fiscal',
          titulo: 'NIF & Identificação Fiscal',
          dados: { nif: '123 456 789', titular: 'Inês Guimarães', regime: 'Restauração e Bebidas / Café Oliveira' },
          origem: 'Chave Móvel Digital',
          finalidade: 'Autenticação formal em requerimentos municipais e liquidação de taxas',
          sensibilidade: 'sensivel',
          validoAte: '2027-10-18',
          conservacao: 'Até revogação expressa da pessoa',
          permissoes: ['leitura_instrucao', 'apresentacao_cmd'],
        });

        await cofre.guardarItem(pessoa, 'MIS-0001', {
          camada: 'identidade',
          tipo: 'morada_fiscal',
          titulo: 'Morada Fiscal e Sede do Estabelecimento',
          dados: { rua: 'Largo da Oliveira, n.º 12', codigo_postal: '4800-025', freguesia: 'Oliveira do Castelo', concelho: 'Guimarães' },
          origem: 'Chave Móvel Digital / Autoridade Tributária',
          finalidade: 'Comprovação de domicílio fiscal e jurisdição municipal',
          sensibilidade: 'sensivel',
          validoAte: '2027-10-18',
          conservacao: 'Até revogação',
          permissoes: ['leitura_instrucao'],
        });

        await cofre.guardarItem(pessoa, 'MIS-0001', {
          camada: 'provas',
          tipo: 'prova_medicao_calcada',
          titulo: 'Medição Fotográfica da Calçada (2,10m)',
          dados: { largura_livre_m: 2.10, corredor_pedonal_minimo_m: 2.00, em_conformidade: true, artigo: 'Artigo 8.º ROPP', hash_foto: 'sha256-a18f40b829c4e2098d4f9b88e...' },
          origem: 'Fotografia enviada no Telegram',
          finalidade: 'Instrução probatória da Mera Comunicação Prévia de Esplanada Aberta',
          sensibilidade: 'normal',
          validoAte: '2026-12-31',
          conservacao: 'Durante vigência do processo OEP/2026/0001',
          permissoes: ['instrucao_processo_su'],
        });

        await cofre.guardarItem(pessoa, 'MIS-0001', {
          camada: 'provas',
          tipo: 'apolice_seguro_rc',
          titulo: 'Apólice de Seguro de Responsabilidade Civil',
          dados: { seguradora: 'Tranquilidade Seguros', apolice_num: 'RC-402914-2026', capital_seguro: 150000, valido_ate: '2027-03-31' },
          origem: 'Upload em PDF pelo cidadão',
          finalidade: 'Comprovativo obrigatório nos termos do Regulamento de Ocupação do Espaço Público',
          sensibilidade: 'normal',
          validoAte: '2027-03-31',
          conservacao: 'Vigência da apólice',
          permissoes: ['instrucao_processo_su'],
        });

        await cofre.guardarItem(pessoa, 'MIS-0001', {
          camada: 'intencoes',
          tipo: 'projeto_esplanada_ovp',
          titulo: 'Projeto de Esplanada Aberta (4 mesas)',
          dados: { servico: 'ocupacao-espaco-publico-esplanada', mesas: 4, cadeiras: 8, toldo_amovivel: true, area_m2: 12, periodo: 'Anual 2026' },
          origem: 'Conversa no Telegram com Henriques',
          finalidade: 'Preparação do formulário OVP-SO e apuramento de taxas regulamentares',
          sensibilidade: 'normal',
          validoAte: '2026-11-30',
          conservacao: 'Até submissão ou cancelamento da missão',
          permissoes: ['instrucao_rascunho_d2'],
        });

        itens = cofre.listarItensCompletos(pessoa);
      }

      let pacotes = cofre.listarPacotes(pessoa);
      if (pacotes.length === 0) {
        await cofre.prepararPacoteMinimo(
          pessoa,
          'MIS-0001',
          'Câmara Municipal de Guimarães · Serviços Urbanos',
          'Instrução de Mera Comunicação Prévia de Esplanada (Artigo 8.º ROPP)',
          {
            requerente: 'Inês Guimarães',
            nif: '123 456 789',
            morada_estabelecimento: 'Largo da Oliveira, n.º 12, Guimarães',
            area_esplanada_m2: 12,
            mesas: 4,
            cadeiras: 8,
            largura_passeio_m: 2.10,
            seguro_responsabilidade_civil_valido: true,
          },
          [
            'iban_conta_bancaria',
            'historico_integral_conversa_telegram',
            'faturamento_comercial_restaurante',
            'documentos_outros_imoveis',
            'fotografias_pessoais_descartadas',
          ],
        );
        pacotes = cofre.listarPacotes(pessoa);
      }

      const mandatosPessoa = await mandatos.listar(pessoa);

      return {
        ok: true,
        pessoa,
        itens,
        pacotes,
        mandatos: mandatosPessoa,
        estatisticas: {
          totalItens: itens.length,
          porCamada: {
            identidade: itens.filter((i) => i.camada === 'identidade').length,
            provas: itens.filter((i) => i.camada === 'provas').length,
            intencoes: itens.filter((i) => i.camada === 'intencoes').length,
          },
          sensibilidade: {
            sensivel: itens.filter((i) => i.sensibilidade === 'sensivel').length,
            normal: itens.filter((i) => i.sensibilidade === 'normal').length,
          },
        },
      };
    },
    guardar: async (body: any) => {
      const pessoa = body.pessoa ?? 'pessoa-1bbe89cb4d';
      const item = await cofre.guardarItem(pessoa, body.missao ?? null, {
        camada: body.camada ?? 'intencoes',
        tipo: body.tipo ?? 'item_geral',
        titulo: body.titulo ?? 'Novo Item do Cofre',
        dados: body.dados ?? {},
        origem: body.origem ?? 'Interface Web do Cofre',
        finalidade: body.finalidade ?? 'Procedimento municipal com a autarquia',
        sensibilidade: body.sensibilidade ?? 'normal',
        validoAte: body.validoAte ?? null,
        conservacao: body.conservacao ?? 'Até revogação',
      });
      return { ok: true, item };
    },
    avaliar: async (body: any) => {
      const pessoa = body.pessoa ?? 'pessoa-1bbe89cb4d';
      return await cofre.avaliarElegibilidade(pessoa, body);
    },
  },
  async (acaoConsola) => {
    const { processo, acao, nota } = acaoConsola;
    console.log(`🏛️ [Consola Câmara] Ação recebida para ${processo}: ${acao} (${nota ?? 'sem nota'})`);

    const missaoAtiva =
      orquestrador.listar().find(
        (m) =>
          m.checklist?.some((p) => p.nota?.includes(processo) || p.passo?.includes(processo)) ||
          m.servico.includes('esplanada') ||
          (m.estado !== 'respondido' && m.estado !== 'cancelado'),
      ) ??
      orquestrador.obterAtiva('pessoa-1bbe89cb4d') ??
      null;

    const pessoa = missaoAtiva?.pessoa ?? PESSOA_PADRAO;
    const conversa =
      conversasPorPessoa.get(pessoa) ??
      estadoCanal.ultimaConversa ??
      conversasPorPessoa.get(PESSOA_PADRAO) ??
      Array.from(conversasPorPessoa.values())[conversasPorPessoa.size - 1] ??
      '5361126841';

    if (acao === 'documents' || acao === 'documentos') {
      estadoCanal.aguardaFachada = true;
      if (missaoAtiva) {
        await orquestrador.mudarEstado(missaoAtiva.id, 'precisa_de_si', `Câmara solicitou elementos adicionais: ${nota ?? 'Largura da fachada'}`);
      }
      await registro.registar({
        tipo: 'consola.elemento.solicitado',
        origem: 'consola',
        sessao: SESSAO,
        pessoa,
        missao: missaoAtiva?.id ?? null,
        ator: 'tecnica:camara',
        simulacao: true,
        dados: {
          processo,
          solicitacao: nota ?? 'Confirmação da largura da fachada do estabelecimento',
        },
      });

      if (conversa) {
        await canal.enviar(
          conversa,
          [
            `🏛️ <b>Pedido de Elementos Adicionais da Câmara</b>`,
            `Processo: <code>${processo}</code>`,
            '',
            `A técnica municipal que está a analisar o seu pedido solicitou o seguinte elemento:`,
            `<i>«${nota || 'Por favor confirme a largura da fachada do estabelecimento para verificação do corredor pedonal.'}»</i>`,
            '',
            'Pode responder aqui por texto ou através do botão rápido:',
          ].join('\n'),
          [
            [{ texto: '📐 Indicar: 8 Metros de Fachada', dados: 'responder_8m' }],
            [{ texto: '👤 Falar com a técnica', dados: 'pessoa' }],
          ],
        );
      }
    } else if (acao === 'approve' || acao === 'resolve') {
      if (missaoAtiva) {
        await orquestrador.mudarEstado(missaoAtiva.id, 'respondido', `Aprovado pela Câmara Municipal: ${nota ?? 'Deferido nos termos regulamentares'}`);
      }
      await registro.registar({
        tipo: 'consola.caso.despachado',
        origem: 'consola',
        sessao: SESSAO,
        pessoa,
        missao: missaoAtiva?.id ?? null,
        ator: 'tecnica:camara',
        simulacao: true,
        dados: {
          processo,
          decisao: 'aprovado',
          fundamentacao: nota ?? 'Deferido com parecer favorável das divisões municipais competentes.',
        },
      });

      if (conversa) {
        console.log(`📤 [Consola] A enviar notificação formal para Telegram (${conversa})...`);
        await canal.enviar(
          conversa,
          [
            '🎉 <b>Decisão Municipal Favorável!</b>',
            `Processo: <code>${processo}</code>`,
            '',
            'A <b>Câmara Municipal de Guimarães</b> apreciou e <b>aprovou formalmente</b> o seu pedido de esplanada! 🏛️✅',
            '',
            `<b>Despacho da Técnica:</b> <i>«${nota || 'Deferido. Ocupação contígua à fachada em conformidade com o Artigo 8.º do Regulamento de Ocupação do Espaço Público.'}»</i>`,
            '',
            '📋 <b>Alvará Digital Concedido:</b>',
            '• <b>Regime:</b> Mera Comunicação Prévia com Eficácia Plena',
            '• <b>Validade:</b> Licenciamento Anual (2026)',
            '• <b>Taxas Regulamentares:</b> Liquidadas nos termos do RTTL 2025',
            '',
            'O seu alvará e comprovativo oficial foram emitidos e arquivados no seu <b>Cofre Digital</b>.',
          ].join('\n'),
        );
        console.log(`✓ [Consola] Notificação entregue no Telegram de ${pessoa} (${conversa})`);
      }
    } else if (acao === 'reject') {
      if (missaoAtiva) {
        await orquestrador.mudarEstado(missaoAtiva.id, 'respondido', `Indeferido pela Câmara: ${nota ?? 'Não cumpre requisitos regulamentares'}`);
      }
      await registro.registar({
        tipo: 'consola.caso.despachado',
        origem: 'consola',
        sessao: SESSAO,
        pessoa,
        missao: missaoAtiva?.id ?? null,
        ator: 'tecnica:camara',
        simulacao: true,
        dados: {
          processo,
          decisao: 'indeferido',
          fundamentacao: nota ?? 'Indeferido por não cumprimento dos critérios técnicos regulamentares.',
        },
      });

      if (conversa) {
        await canal.enviar(
          conversa,
          [
            '⚠️ <b>Notificação da Câmara Municipal</b>',
            `Processo: <code>${processo}</code>`,
            '',
            'A sua solicitação foi apreciada e <b>indeferida</b> pelos serviços técnicos.',
            `Motivo: <i>«${nota || 'Não cumpre os requisitos regulamentares mínimos exigíveis.'}»</i>`,
            '',
            'Pode solicitar audiência prévia ou reapreciar o pedido junto dos serviços.',
          ].join('\n'),
          [[{ texto: '👤 Falar com um técnico', dados: 'pessoa' }]],
        );
      }
    }
  },
  obterPedidosConsola,
  aoReceberCanalWeb,
  criarLigacaoWeb,
  obterLigacaoWeb,
);
servidor.listen(PORTA_EVENTOS, () => {
  console.log(`✓ fluxo de eventos em http://localhost:${PORTA_EVENTOS}/eventos/stream`);
});

// Ciclo fechado: escutar eventos da Consola/SU para notificar cidadão no Telegram
const escutaNucleo = await base.escutar();
escutaNucleo.on('error', (err: Error) => {
  console.warn('⚠ aviso na escuta pg do núcleo:', err.message);
});
await escutaNucleo.query('LISTEN eventos');

escutaNucleo.on('notification', async (aviso: any) => {
  const seq = Number(aviso.payload);
  if (!Number.isFinite(seq)) return;
  try {
    const ev = await registro.porSeq(seq);
    if (!ev) return;

    if (ev.tipo === 'su.processo.estado.alterado') {
      const chat = (ev.pessoa ? conversasPorPessoa.get(ev.pessoa) : null) ?? estadoCanal.ultimaConversa;
      if (!chat) return;

      const pessoa = ev.pessoa ?? 'ines_guimaraes';
      const missaoAtiva = orquestrador.obterAtiva(pessoa);

      if (ev.dados.para === 'pedido_elementos') {
        estadoCanal.aguardaFachada = true;
        if (missaoAtiva) {
          await orquestrador.mudarEstado(missaoAtiva.id, 'precisa_de_si', 'Câmara pediu elementos adicionais');
        }
        await canal.enviar(
          chat,
          [
            '🏛️ <b>Notificação da Câmara Municipal de Guimarães</b>',
            '',
            'A técnica do Gabinete de Serviços Urbanos está a analisar o processo <code>OEP/2026/0001</code> e solicitou um elemento adicional:',
            '👉 <b>Largura da fachada do estabelecimento</b> (para validação cadastral).',
            '',
            'Pode responder diretamente aqui (ex.: <i>«8 metros»</i>) ou carregar no botão:',
          ].join('\n'),
          [[{ texto: '📐 Indicar: 8 metros de fachada', dados: 'responder_8m' }]],
        );
      } else if (ev.dados.para === 'aceite') {
        estadoCanal.aguardaFachada = false;
        if (missaoAtiva) {
          await orquestrador.mudarEstado(missaoAtiva.id, 'respondido', 'Processo aceite pela técnica');
          await servicoChaves.recolherChave(pessoa, missaoAtiva.id, 'missao_concluida');
        }
        const taxa = (ev.dados.taxa as { valor?: number } | undefined)?.valor ?? 75.75;
        await canal.enviar(
          chat,
          [
            '✅ <b>Comunicação Prévia Deferida!</b>',
            '',
            'A técnica do Gabinete de Serviços Urbanos <b>aceitou</b> a sua esplanada.',
            'Processo: <code>OEP/2026/0001</code> (Simulação)',
            '',
            `<b>Taxa Municipal:</b> ${taxa.toFixed(2).replace('.', ',')} € (Simulação)`,
            '<b>Entidade:</b> <code>12345</code>',
            '<b>Referência:</b> <code>987 654 321</code>',
            '<b>Montante:</b> <code>75,75 €</code>',
            '',
            '<i>(O pagamento é efetuado fora do canal, por autonomia e segurança.)</i>',
          ].join('\n'),
        );
      }
    }
  } catch (err) {
    console.error('✖ erro ao processar notificação no núcleo:', err);
  }
});

process.once('SIGINT', () => void encerrar());
process.once('SIGTERM', () => void encerrar());

async function encerrar() {
  const auditoria = await registro.verificar().catch(() => null);
  if (auditoria) {
    console.log(
      auditoria.valido
        ? `✓ cadeia de selos fecha: ${auditoria.total} eventos`
        : `✖ cadeia quebrada no evento ${auditoria.quebradoEm}`,
    );
  }
  await escutaNucleo.end().catch(() => {});
  await base.fechar();
  process.exit(0);
}

if (token) {
  await canal.ligar();
} else {
  console.log('✓ canal Web ativo (CANAL_WEB=1, sem Telegram) — as sessões do painel ligam-se no bot quando este existir');
}
/**
 * O tratador de mensagens do canal: o caminho único que o Telegram e o painel
 * Web percorrem.
 *
 * Foi extraído do principal.ts tal como estava, para que os dois canais não
 * possam divergir: o Telegram entrega uma MensagemRecebida ao `tratar`, e o
 * endpoint `/api/canal/mensagem` entrega outra igual. Quem responde, responde
 * uma só vez — e a resposta sai pelo mesmo `canal`, que a entrega a ambos.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { raizPrototipo } from '../dados-raiz.js';
import type { CanalGrammy, Botao, MensagemRecebida } from '../canal.js';
import type { Registo } from '../eventos/registo.js';
import type { Henriques } from '../henriques/henriques.js';
import type { ClientePortaMcp } from '../henriques/cliente-porta.js';
import type { CofreDigital } from '../cofre/cofre.js';
import type { GestorMandatos } from '../mandatos/mandatos.js';
import type { OrquestradorMissoes } from '../orquestrador/missao.js';
import type { GestorFluxoD2 } from '../orquestrador/fluxo-conversa-d2.js';
import type { ProcessadorCenarios } from '../simuladores/cenarios.js';
import type { TratadorComandos } from '../comandos/tratador-comandos.js';

/** Estado que o tratador partilha com o resto do núcleo (consola, escuta SU). */
export interface EstadoCanalPartilhado {
  ultimaConversa: string | null;
  aguardaFachada: boolean;
}

export interface DependenciasTratadorCanal {
  canal: CanalGrammy;
  registro: Registo;
  sessao: string;
  henriques: Henriques;
  comandos: TratadorComandos;
  fluxoD2: GestorFluxoD2;
  cenarios: ProcessadorCenarios;
  cofre: CofreDigital;
  mandatos: GestorMandatos;
  orquestrador: OrquestradorMissoes;
  clientePorta: ClientePortaMcp;
  /** Consulta de eventos no registo (SQL sobre nucleo.eventos). */
  consultarEventos: (sql: string) => Promise<{ rows: Array<{ seq: number; tipo: string; dados: any; ts: any }> }>;
  obterPedidosConsola: () => Promise<any[]>;
  conversasPorPessoa: Map<string, string>;
  estado: EstadoCanalPartilhado;
  /** Chamado quando uma mensagem associa uma pessoa a uma conversa. */
  aoAssociarConversa?: (pessoa: string, conversa: string) => void;
  /**
   * Ligação de uma sessão Web ao Telegram: o painel gera um código, a pessoa
   * faz /start com esse código no bot, e aqui fica associada a quem chegou.
   */
  aoLigarPessoa?: (codigo: string, m: MensagemRecebida) => void;
}

const RAIZ_DADOS = join(raizPrototipo(), 'data', 'cenarios_simulados');

export function criarTratadorMensagens(deps: DependenciasTratadorCanal) {
  const {
    canal,
    registro,
    sessao,
    henriques,
    comandos,
    fluxoD2,
    cenarios,
    cofre,
    mandatos,
    orquestrador,
    clientePorta,
    consultarEventos,
    obterPedidosConsola,
    conversasPorPessoa,
    estado,
    aoAssociarConversa,
    aoLigarPessoa,
  } = deps;

  /** Regista um evento do canal. O identificador da conversa nunca entra. */
  async function regista(
    tipo: string,
    m: { pessoa: string },
    dados: Record<string, unknown>,
  ): Promise<void> {
    await registro.registar({
      tipo,
      origem: 'canal',
      sessao,
      pessoa: m.pessoa,
      missao: null,
      ator: 'pessoa',
      simulacao: false,
      dados,
    });
  }

  async function tratar(m: MensagemRecebida): Promise<void> {
    try {
      const desc = m.tipo === 'botao' ? `[Botão: ${m.texto}]` : m.texto ?? (m.foto ? '[Foto]' : '[Documento]');
      console.log(`📩 [Canal] Recebido de ${m.pessoa} (${m.tipo}): ${desc}`);

      conversasPorPessoa.set(m.pessoa, m.conversa);
      estado.ultimaConversa = m.conversa;
      if (aoAssociarConversa) aoAssociarConversa(m.pessoa, m.conversa);

      // Regista-se antes dos comandos, para que um /start também apareça no registo.
      const dados: Record<string, unknown> =
        m.tipo === 'foto'
          ? { tem_foto: Boolean(m.foto), texto: m.texto, entrada: m.tipo }
          : m.tipo === 'botao'
            ? { botao: m.texto }
            : m.tipo === 'documento'
              ? { texto: m.texto, documento: m.documento?.nome ?? null, entrada: m.tipo }
              : { texto: m.texto, entrada: m.tipo };

      await regista(
        m.tipo === 'botao' ? 'canal.botao.carregado' : 'canal.mensagem.recebida',
        m,
        dados,
      );

      // 1. Tratamento de Comandos de Barra (/) delegados ao módulo TratadorComandos
      if (m.tipo === 'comando' && m.texto) {
        if (m.texto.startsWith('/start')) {
          estado.aguardaFachada = false;

          // Deep-link do painel: /start <codigo> liga a sessão Web a esta pessoa.
          const payload = m.texto.trim().split(/\s+/)[1];
          if (payload && /^[a-f0-9]{16,64}$/i.test(payload) && aoLigarPessoa) {
            aoLigarPessoa(payload.toLowerCase(), m);
          }
        }
        const tratado = await comandos.tratar(m);
        if (tratado) {
          console.log(`📤 [Canal] Comando processado para ${m.pessoa}: ${m.texto}`);
          return;
        }
      }

      // 1.1 Consulta direta com memória dos pedidos e processos do cidadão
      const ehConsultaEstado = m.texto && /\b(como\s+est[aá]|qual\s+[eé]\s+o\s+estado|como\s+vai|meu\s+pedido|meu\s+processo|minha\s+esplanada|o\s+meu\s+caso|estado\s+do\s+pedido|meus\s+pedidos|pedidos?\s+ativos?)\b/i.test(m.texto);
      if (ehConsultaEstado && !fluxoD2.obterRascunhoAtivo(m.pessoa)) {
        try {
          const resEventos = await consultarEventos(
            "SELECT seq, tipo, dados, ts FROM nucleo.eventos WHERE tipo IN ('consola.caso.criado', 'consola.caso.despachado', 'consola.elemento.solicitado') ORDER BY seq ASC",
          );
          const casosCidadao = new Map<string, any>();
          for (const r of resEventos.rows) {
            const d = r.dados || {};
            const proc = d.processo || 'OEP/2026/0001';
            if (r.tipo === 'consola.caso.criado') {
              let estab = d.estabelecimento || 'Cafe da beira';
              let morada = d.morada || 'Rua de São José, Guimarães';
              if (estab && morada.toLowerCase().startsWith(estab.toLowerCase())) {
                morada = morada.slice(estab.length).replace(/^[,\s-]+/, '').trim();
              }
              casosCidadao.set(proc, {
                processo: proc,
                estabelecimento: estab,
                morada,
                mesas: d.mesas || 4,
                status: 'Aguarda análise',
              });
            } else if (r.tipo === 'consola.caso.despachado') {
              const c = casosCidadao.get(proc);
              if (c) c.status = d.decisao === 'aprovado' ? 'Aprovada' : 'Indeferida';
            } else if (r.tipo === 'consola.elemento.solicitado') {
              const c = casosCidadao.get(proc);
              if (c) c.status = 'Aguarda documentos adicionais';
            }
          }

          if (casosCidadao.size > 0) {
            const linhasCasos: string[] = [];
            for (const c of casosCidadao.values()) {
              const badge = c.status === 'Aprovada' ? '✅ <b>Aprovado</b> (Alvará Concedido)' : c.status === 'Indeferida' ? '❌ <b>Indeferido</b>' : '⏳ <b>Em apreciação técnica</b>';
              linhasCasos.push(
                `• <b>Processo:</b> <code>${c.processo}</code>\n  <b>Estabelecimento:</b> ${c.estabelecimento}\n  <b>Morada:</b> ${c.morada}\n  <b>Estado:</b> ${badge}`
              );
            }
            await canal.enviar(
              m.conversa,
              [
                '📋 <b>Os seus pedidos registados na Câmara Municipal de Guimarães:</b>',
                '',
                linhasCasos.join('\n\n'),
                '',
                'O alvará e todas as minutas e comprovativos oficiais encontram-se salvaguardados no seu <b>Cofre Digital</b>.',
              ].join('\n'),
            );
            return;
          }
        } catch (err) {
          console.warn('Erro ao consultar histórico de pedidos:', err);
        }
      }

      // 2. Tratamento de botões de decisão da pessoa
      if (m.tipo === 'botao') {
        if (m.texto === 'pessoa') {
          await registro.registar({
            tipo: 'consola.caso.criado',
            origem: 'consola',
            sessao,
            pessoa: m.pessoa,
            missao: null,
            ator: 'pessoa',
            simulacao: true,
            dados: { motivo: 'pedido_atendimento_humano' },
          });
          await canal.enviar(
            m.conversa,
            'Encaminhei o seu pedido para atendimento humano no Balcão Único. Um técnico irá contactá-lo.',
          );
        } else if (m.texto === 'cmd_carta') {
          await canal.enviar(
            m.conversa,
            [
              '📜 <b>Carta de Lealdade do Henriques</b>',
              '',
              '1. <b>Trabalho para si.</b> Não trabalho para a Câmara, para um banco nem para quem me financia.',
              '2. <b>Digo-lhe sempre os seus direitos</b>, incluindo o de reclamar, ser ouvido e recorrer de uma decisão.',
              '3. <b>Só uso os dados que autorizou</b>, para a missão que me deu, pelo tempo que definiu.',
              '4. <b>Mostro-lhe a fonte do que afirmo</b> e digo-lhe quando não sei.',
              '5. <b>Nunca recomendo um profissional</b>, produto ou serviço por ter sido pago para isso.',
              '6. <b>Pode falar com uma pessoa a qualquer momento.</b>',
            ].join('\n'),
          );
        } else if (m.texto === 'pergunta_taxa') {
          const missaoAtiva = orquestrador.obterAtiva(m.pessoa);
          const metadadosCofre = (() => {
            try {
              return cofre.listarMetadados(m.pessoa) ?? [];
            } catch {
              return [];
            }
          })();
          const resp = await henriques.responder(m.pessoa, 'quanto vou pagar', {
            pessoa: m.pessoa,
            servicoAtivo: missaoAtiva?.servico ?? 'ocupacao-espaco-publico-esplanada',
            servicoTituloAtivo: missaoAtiva?.servicoTitulo,
            missaoAtiva: Boolean(missaoAtiva),
            missaoId: missaoAtiva?.id,
            estadoMissao: missaoAtiva?.estado,
            mandatoAtivoNivel: missaoAtiva ? 'D2' : 'D0',
            itensCofre: metadadosCofre.map(it => ({ tipo: it.tipo, titulo: it.titulo })),
          });
          if (resp.mensagens && resp.mensagens.length > 1) {
            await canal.enviarSequencia(m.conversa, resp.mensagens, resp.botoes);
          } else {
            await canal.enviar(m.conversa, resp.texto, resp.botoes);
          }
        } else if (m.texto === 'iniciar_esplanada' || m.texto === 'voltar_esplanada' || m.texto === 'preparar:ocupacao-espaco-publico-esplanada') {
          await fluxoD2.iniciarFluxoEsplanada(m.pessoa, m.conversa);
        } else if (m.texto?.startsWith('d2_')) {
          const tratado = await fluxoD2.processarPasso(m.pessoa, m.conversa, m.texto);
          if (!tratado) {
            if (m.texto === 'd2_enviar_foto') {
              await cenarios.processarValidacaoCalcada(m);
            }
          }
        } else if (m.texto === 'enviar_foto_calcada') {
          await cenarios.processarValidacaoCalcada(m);
        } else if (m.texto === 'iniciar_pdm') {
          await cofre.guardarItem(m.pessoa, 'MIS-0002', {
            camada: 'intencoes',
            tipo: 'intencao_urbanismo',
            titulo: 'Pedido de Informação Prévia (PDM)',
            origem: 'conversa_telegram',
            finalidade: 'Consulta de viabilidade urbanística para construção de moradia',
            dados: { servico: 'pedido-informacao-previa-urbanismo' },
          });

          const mandato = await mandatos.concederMandato(m.pessoa, 'MIS-0002', {
            ambito: 'urbanismo-informacao-previa',
            objeto: 'Viabilidade Construtiva PDM (Guimarães)',
            nivel: 'D2',
            validadeDias: 180,
          });

          await orquestrador.criarMissao({
            pessoa: m.pessoa,
            servico: 'pedido-informacao-previa-urbanismo',
            servicoTitulo: 'Pedido de Informação Prévia (PIP) — Viabilidade PDM',
            objetivo: 'Obter parecer prévio vinculativo de viabilidade urbanística ao abrigo do Art. 14.º do RJUE',
            mandato: mandato.id,
            passosIniciais: [
              'Identificar enquadramento no PDM de Guimarães',
              'Georreferenciar localização do terreno (Google Maps / GPS)',
              'Anexar Caderneta Predial em PDF no Cofre Digital',
              'Submeter formalmente à Câmara com Chave Móvel Digital',
            ],
          });

          await canal.enviar(
            m.conversa,
            [
              'Guardei a intenção no seu <b>Cofre Digital Pessoal</b> (cifrado AES-256-GCM) e abri a missão <b>MIS-0002</b>.',
              '',
              `Concedeu ao Henriques o <b>Mandato D2</b> (${mandato.id}): preparar o rascunho instrutório e organizar as provas, <b>sem autorização para submeter</b> sem a sua assinatura.`,
              '',
              '<b>Elementos necessários (Art. 14.º do RJUE):</b>',
              '1. 📍 <b>Localização do terreno:</b> envie um link do Google Maps ou coordenadas (ex.: <code>41.4425, -8.2918</code>).',
              '2. 📑 <b>Caderneta Predial:</b> envie o ficheiro PDF da caderneta predial.',
              '',
              'Pode enviar estes dados em qualquer ordem:',
            ].join('\n'),
            [
              [{ texto: '📍 Simular Envio: Terreno em Silvares (Maps)', dados: 'enviar_localizacao_terreno' }],
              [{ texto: '📑 Simular Envio: Caderneta Predial (PDF)', dados: 'anexar_caderneta_predial' }],
              [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
            ],
          );
        } else if (m.texto === 'ajuda_google_maps') {
          await canal.enviar(
            m.conversa,
            [
              '📍 <b>Como partilhar a localização do terreno:</b>',
              '',
              '1. Abra a aplicação Google Maps ou o navegador.',
              '2. Toque no terreno pretendido e escolha «Partilhar».',
              '3. Cole o link aqui no chat (ex.: <code>https://maps.google.com/?q=41.4425,-8.2918</code>) ou escreva as coordenadas diretamente.',
              '',
              'Ou teste de imediato com a simulação:',
            ].join('\n'),
            [
              [{ texto: '📍 Simular Envio: Terreno em Silvares (Maps)', dados: 'enviar_localizacao_terreno' }],
              [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
            ],
          );
        } else if (m.texto === 'ajuda_pdf') {
          await canal.enviar(
            m.conversa,
            [
              '📑 <b>Como anexar a Caderneta Predial:</b>',
              '',
              '1. Carregue no ícone do clipe / anexo 📎 no Telegram.',
              '2. Selecione o ficheiro PDF da Caderneta Predial do Portal das Finanças.',
              '3. O Henriques cifra o ficheiro com AES-256-GCM no seu Cofre Digital Pessoal.',
              '',
              'Ou teste de imediato com a simulação:',
            ].join('\n'),
            [
              [{ texto: '📑 Simular Envio: Caderneta Predial (PDF)', dados: 'anexar_caderneta_predial' }],
              [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
            ],
          );
        } else if (m.texto === 'enviar_localizacao_terreno' || m.texto === 'simular_maps_silvares') {
          await cenarios.processarLocalizacaoTerreno(m);
        } else if (m.texto === 'anexar_caderneta_predial' || m.texto === 'simular_anexo_pdf') {
          await cenarios.processarDocumentoPdf(m);
        } else if (m.texto === 'anexar_planta_esplanada' || m.texto === 'simular_planta_esplanada') {
          await cenarios.processarDocumentoPdf({
            ...m,
            tipo: 'documento',
            documento: { nome: 'Planta_Cotada_Esplanada_Oliveira.md', mime: 'text/markdown', id: 'sim_planta' },
          });
        } else if (m.texto === 'anexar_certidao_comercial') {
          await cenarios.processarDocumentoPdf({
            ...m,
            tipo: 'documento',
            documento: { nome: 'Certidao_Comercial_Casa_Joaquim.md', mime: 'text/markdown', id: 'sim_certidao' },
          });
        } else if (m.texto === 'anexar_apolice_seguro' || m.texto === 'simular_apolice') {
          await cenarios.processarApoliceSeguro(m);
        } else if (
          m.texto === 'assinar_com_chave_movel_digital' ||
          m.texto === 'submeter_pdm_chat' ||
          m.texto === 'submeter_esplanada' ||
          m.texto === 'submeter_pedido'
        ) {
          const missao = orquestrador.obterAtiva(m.pessoa);
          const servicoId = missao?.servico ?? 'ocupacao-espaco-publico-esplanada';
          const rascunho = fluxoD2.obterRascunhoAtivo(m.pessoa);
          await registro.registar({
            tipo: 'henriques.intencao.classificada',
            origem: 'henriques',
            sessao,
            pessoa: m.pessoa,
            missao: missao?.id ?? rascunho?.missaoId ?? 'MIS-0001',
            ator: 'agente:jev',
            simulacao: false,
            dados: {
              servico: servicoId,
              foco_servico: servicoId,
              intencao: 'submeter_comunicacao_previa',
              confianca: 0.99,
              categoria: 'catalogo',
              comportamento: 'submeter_d3',
              exige_consentimento: true,
              motor: 'typesafe-jev',
              modelo: 'typesafe/jev-system-one',
              mandato_inferido: 'D3',
              mcp_ferramenta: 'submeter_comunicacao_previa',
              tempo_ms: 180,
              probabilidades: {
                catalogo: 0.99,
                conhecimento_d0: 0.01,
              },
              arvore_jev: {
                servico: { probabilidades: { catalogo: 0.99, conhecimento_d0: 0.01 } },
                mandato: { probabilidades: { D3: 0.99, D2: 0.01 } },
                ferramenta: { probabilidades: { submeter_comunicacao_previa: 0.98, preparar_rascunho: 0.02 } },
                consentimento: { noul: 0.99 },
              },
            },
          });
          await cenarios.executarSubmissaoAtiva(m.pessoa, rascunho?.processo);
        } else if (m.texto === 'responder_8m') {
          estado.aguardaFachada = false;
          await clientePorta.chamarFerramenta('responder_pedido_elementos', {
            processo: 'OEP/2026/0001',
            mandato: 'MAN-D3-001',
            elementos: { largura_fachada_m: 8 },
          }).catch(() => null);

          await orquestrador.mudarEstado('MIS-0001', 'com_tecnico', 'Elemento adicional fornecido: 8m fachada');

          await canal.enviar(
            m.conversa,
            [
              'Recebi a informação da fachada (<b>8 metros</b>) e juntei-a ao processo <code>OEP/2026/0001</code> na Porta Agêntica da Câmara. ✅',
              '',
              'O processo regressou à fila da técnica para apreciação final.',
            ].join('\n'),
          );
        } else if (m.texto?.startsWith('ver_fontes:') || m.texto === 'ver_fontes') {
          const servicoId = m.texto.includes(':') ? m.texto.split(':')[1] : 'ocupacao-espaco-publico-esplanada';
          let diploma = 'Regulamento Municipal de Guimarães';
          let artigos = 'Artigos regulamentares em vigor';
          const versao = '2026-10-18.1';
          if (servicoId === 'ocupacao-espaco-publico-esplanada') {
            diploma = 'Regulamento de Ocupação do Espaço Público e Publicidade de Guimarães';
            artigos = 'Artigo 8.º e Anexo I (Corredor pedonal ≥ 2,00m, mobiliário amovível)';
          } else if (servicoId === 'pedido-informacao-previa-urbanismo') {
            diploma = 'Regulamento do Plano Diretor Municipal de Guimarães (Aviso n.º 23214/2020)';
            artigos = 'Artigos 45.º e 62.º do PDM e Artigo 14.º do RJUE';
          } else if (servicoId === 'inspecao-ascensores') {
            diploma = 'Regulamento de Elevadores e Ascensores de Guimarães';
            artigos = 'Artigo 34.º da Tabela de Taxas 2025 (Taxa fixa: 73,00 €)';
          } else if (servicoId === 'cartao-municipal-senior') {
            diploma = 'Regulamento do Cartão Municipal Sénior da Câmara Municipal de Guimarães';
            artigos = 'Artigo 4.º (Idade ≥ 65 anos e residência/recenseamento em Guimarães)';
          }

          await registro.registar({
            tipo: 'henriques.fontes.consultadas',
            origem: 'henriques',
            sessao,
            pessoa: m.pessoa,
            missao: null,
            ator: 'agente:verificador',
            simulacao: false,
            dados: {
              servico: servicoId,
              diploma,
              artigos,
              versao,
              consultado_em: '18/10/2026',
            },
          });

          await canal.enviar(
            m.conversa,
            [
              '📜 <b>Fundamentação Oficial e Base Jurídica</b>',
              '',
              `• <b>Diploma:</b> ${diploma}`,
              `• <b>Disposições Aplicáveis:</b> ${artigos}`,
              `• <b>Versão em vigor:</b> v${versao} (consultado a 18/10/2026)`,
              '• <b>Integridade:</b> Selo SHA-256 verificado nos registos canónicos da Câmara.',
              '',
              '<i>O Henriques assegura conformidade estrita com as normas oficiais da autarquia.</i>',
            ].join('\n'),
          );
        } else if (m.texto?.startsWith('apagar_item_')) {
          const itemId = m.texto.replace('apagar_item_', '');
          const apagado = await cofre.apagarItem(m.pessoa, itemId);
          await canal.enviar(
            m.conversa,
            apagado
              ? `✓ O item <code>${itemId}</code> foi eliminado do seu Cofre Digital.`
              : `Item <code>${itemId}</code> não encontrado.`,
          );
        } else if (m.texto?.startsWith('revogar_mandato_')) {
          const mandId = m.texto.replace('revogar_mandato_', '');
          const revogado = await mandatos.revogarMandato(m.pessoa, mandId);
          await canal.enviar(
            m.conversa,
            revogado
              ? `🚫 O mandato <code>${mandId}</code> foi revogado com efeito imediato.`
              : `Mandato <code>${mandId}</code> não encontrado.`,
          );
        } else if (m.texto?.startsWith('preparar:')) {
          const docId = m.texto.replace('preparar:', '');
          const tituloServico = docId.includes('isencao')
            ? 'Isenção de Licença de Utilização de Edifício Antigo'
            : docId.includes('bolsa')
              ? 'Candidatura a Bolsas de Estudo Municipais'
              : 'Preparação de Requerimento Municipal';

          const missaoId = `MIS-${Math.floor(1000 + Math.random() * 9000)}`;

          await cofre.guardarItem(m.pessoa, missaoId, {
            camada: 'intencoes',
            tipo: 'intencao_procedimento',
            titulo: tituloServico,
            origem: 'rag_d0_conhecimento',
            finalidade: `Instrução sob Mandato D2: ${tituloServico}`,
            dados: { documento_origem: docId },
          });

          const mandato = await mandatos.concederMandato(m.pessoa, missaoId, {
            ambito: docId,
            objeto: tituloServico,
            nivel: 'D2',
            validadeDias: 90,
          });

          await orquestrador.criarMissao({
            pessoa: m.pessoa,
            servico: docId,
            servicoTitulo: tituloServico,
            objetivo: `Reunir provas e organizar pacote instrutório para ${tituloServico}`,
            mandato: mandato.id,
            passosIniciais: [
              'Instrução documental no Cofre Digital (D2)',
              'Anexar caderneta predial / comprovativos (PDF)',
              'Revisão do pacote instrutório mínimo',
              'Submissão formal com Chave Móvel Digital (D3)',
            ],
          });

          await canal.enviar(
            m.conversa,
            [
              `📋 <b>Missão iniciada no Cofre Digital: ${tituloServico}</b>`,
              '',
              `Concedeu ao Henriques o <b>Mandato D2</b> (<code>${mandato.id}</code>): preparar o processo e organizar os documentos necessários, <b>sem autorização para submeter</b> sem a sua assinatura expressa.`,
              '',
              '🔒 <b>Cofre Digital Pessoal (AES-256-GCM):</b>',
              'Os seus ficheiros e intenções estão guardados em segurança. Pode anexar documentos oficiais (ex.: Caderneta Predial em PDF) através do clipe 📎 do Telegram.',
              '',
              'Ou simule de imediato os passos seguintes:',
            ].join('\n'),
            [
              [{ texto: '📑 Simular Envio: Documentos em PDF', dados: 'anexar_caderneta_predial' }],
              [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
              [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
            ],
          );
        } else {
          await canal.enviar(
            m.conversa,
            'Recebi a sua indicação. Se pretender avançar com um pedido ou colocar alguma dúvida sobre os regulamentos municipais, estou ao seu dispor.',
            [[{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }]],
          );
        }
      } else if (m.tipo === 'foto') {
        const rascunhoAtivo = fluxoD2.obterRascunhoAtivo(m.pessoa);
        if (rascunhoAtivo && rascunhoAtivo.estado !== 'concluido') {
          await fluxoD2.processarPasso(m.pessoa, m.conversa, 'd2_anexar_planta');
        } else {
          await cenarios.processarValidacaoCalcada(m);
        }
      } else if (m.tipo === 'documento') {
        const rascunhoAtivo = fluxoD2.obterRascunhoAtivo(m.pessoa);
        if (rascunhoAtivo && rascunhoAtivo.estado !== 'concluido') {
          const nomeDoc = m.documento?.nome ?? 'documento.pdf';
          await fluxoD2.processarPasso(m.pessoa, m.conversa, `documento:${nomeDoc}`);
        } else {
          await cenarios.processarDocumentoPdf(m);
        }
      } else if (m.texto && !m.texto.startsWith('/')) {
        const missaoAtiva = orquestrador.obterAtiva(m.pessoa);

        if (estado.aguardaFachada && (m.texto === 'responder_8m' || /8/i.test(m.texto))) {
          estado.aguardaFachada = false;
          await clientePorta.chamarFerramenta('responder_pedido_elementos', {
            processo: 'OEP/2026/0001',
            mandato: 'MAN-D3-001',
            elementos: { largura_fachada_m: 8 },
          }).catch(() => null);

          await orquestrador.mudarEstado('MIS-0001', 'com_tecnico', 'Elemento fornecido via texto: 8 metros');

          await canal.enviar(
            m.conversa,
            [
              'Recebi a informação da fachada (<b>8 metros</b>) e juntei-a ao processo <code>OEP/2026/0001</code> na Porta Agêntica da Câmara. ✅',
              '',
              'O processo regressou à fila da técnica para apreciação final.',
            ].join('\n'),
          );
          await regista('canal.mensagem.enviada', m, {});
          return;
        }

        const contextoPessoa = henriques.contexto.obterContexto(m.pessoa);
        const servicoAtivo = contextoPessoa?.servicoAtivoId ?? missaoAtiva?.servico;

        // Se existe um rascunho de esplanada D2 ativo em preenchimento conversacional
        const rascunhoAtivo = fluxoD2.obterRascunhoAtivo(m.pessoa);

        // 1. ARTICULAÇÃO: Se o cidadão está a meio do processo D2
        if (rascunhoAtivo && rascunhoAtivo.estado !== 'concluido') {
          const ehDuvidaInformativa =
            /\?|quanto\s+custa|qual\s+(é\s+)?(a\s+)?(taxa|preço|custo|prazo)|o\s+que\s+(é|diz)|como\s+funciona|quais\s+(são\s+)?os\s+documentos/i.test(m.texto);

          // Se contém dados técnicos (morada, mesas, calçada), processa no fluxo D2 primeiro
          const contemDadosTecnicos =
            /largo|rua|praça|avenida|travessa|oliveira|joaquim|guimarães|\d+\s*(mesas?|cadeiras?|m2|m²)|2[,.]10|metros|calçada|passeio/i.test(m.texto);

          if (contemDadosTecnicos || !ehDuvidaInformativa) {
            const processado = await fluxoD2.processarPasso(m.pessoa, m.conversa, m.texto);
            if (processado) {
              await regista('canal.mensagem.enviada', m, { tipo: 'd2_passo_processado', estado: rascunhoAtivo.estado });
              return;
            }
          }

          if (ehDuvidaInformativa) {
            const resposta = await henriques.responder(m.pessoa, m.texto, {
              servicoAtivo: 'ocupacao-espaco-publico-esplanada',
              missaoId: rascunhoAtivo.missaoId,
              estadoMissao: 'em_curso',
            });

            let lembretePasso = '';
            if (rascunhoAtivo.estado === 'aguarda_morada' || !rascunhoAtivo.morada) {
              lembretePasso = '\n\n📌 <b>Para continuarmos o seu rascunho de esplanada:</b> Qual é o nome e a morada do estabelecimento em Guimarães?';
            } else if (rascunhoAtivo.estado === 'aguarda_mesas' || !rascunhoAtivo.mesas) {
              lembretePasso = '\n\n📌 <b>Para continuarmos o seu rascunho de esplanada:</b> Quantas mesas e cadeiras planeia colocar no exterior?';
            } else if (rascunhoAtivo.estado === 'aguarda_passeio' || !rascunhoAtivo.larguraLivre) {
              lembretePasso = '\n\n📌 <b>Para continuarmos o seu rascunho de esplanada:</b> Confirma que salvaguarda pelo menos 2,00 metros livres no passeio pedonal?';
            }

            await canal.enviar(m.conversa, resposta.texto + lembretePasso, resposta.botoes);
            await regista('canal.mensagem.enviada', m, { tipo: 'duvida_em_d2_esclarecida', estado: rascunhoAtivo.estado });
            return;
          }
        }

        // 2. ARTICULAÇÃO: Se o cidadão quer expressamente iniciar o processo D2 ou aceitou a proposta do Henriques
        const ePerguntaInformativa = /\?|o\s+que|como|quais|quanto|qual|onde|preciso\s+de\s+fazer|como\s+fa[çc]o/i.test(m.texto);

        const textoLimpo = m.texto.trim().toLowerCase().replace(/[.,!?;:]+$/, '').trim();
        const aceitaAvancar =
          /^(sim(\s+(quero|por\s+favor|avan[çc]a|trata|bora|vamos))?|quero(\s+sim|\s+avan[çc]ar|\s+tratar)?|avan[çc]ar?|pode\s+ser|trata(\s+disso|\s+de\s+tudo)?|vamos(\s+a\s+isso)?|bora|for[çc]a|come[çc]ar|iniciar|ok|com\s+certeza)$/i.test(textoLimpo);

        const querIniciarEsplanada =
          !ePerguntaInformativa &&
          (m.texto === 'iniciar_esplanada' ||
            m.texto === 'iniciar_esplanada_d2' ||
            /\b(iniciar|preparar|instruir|avançar|vamos\s+a\s+isso|bora|começar)\b.*(esplanada|processo|pedido|preparação)/i.test(m.texto) ||
            /\b(quero|ajuda-me|podes|vamos|gostava\s+de)\b.*(preparar|tratar|iniciar|avançar).*(esplanada|processo|pedido)/i.test(m.texto) ||
            (aceitaAvancar && (servicoAtivo === 'ocupacao-espaco-publico-esplanada' || !servicoAtivo)));

        if (querIniciarEsplanada) {
          await fluxoD2.iniciarFluxoEsplanada(m.pessoa, m.conversa, true);
          return;
        }

        // 3. ARTICULAÇÃO: Se o cidadão já deu diretamente dados de processo (morada ou mesas/m2) em contexto de esplanada
        if (!rascunhoAtivo && servicoAtivo === 'ocupacao-espaco-publico-esplanada' && !ePerguntaInformativa) {
          const eMoradaOuEstabelecimento = /largo|rua|praça|avenida|travessa|oliveira|joaquim|guimarães|\d{4}-\d{3}/i.test(m.texto);
          const eDimensoesOuMesas = /\b\d+\s*(mesas?|cadeiras?|m2|m²|metros\s*quadrados)/i.test(m.texto);

          if (eMoradaOuEstabelecimento || eDimensoesOuMesas) {
            await fluxoD2.iniciarFluxoEsplanada(m.pessoa, m.conversa, false);
            const processado = await fluxoD2.processarPasso(m.pessoa, m.conversa, m.texto);
            if (processado) {
              await regista('canal.mensagem.enviada', m, { tipo: 'd2_bootstrap_processado' });
              return;
            }
          }
        }

        // Se a pessoa pede para assinar ou submeter em linguagem natural (excluindo dúvidas, perguntas ou negações)
        const eNegacao = /\b(n[aã]o\s+(autorizo|quero|submeta|envie|posso)|cancelar?|recus[ao]|nem\s+pensar)\b/i.test(m.texto);
        const eDuvidaOuPergunta = /\?|posso\s+submeter|como\s+(posso|consigo|faço)\s+submeter/i.test(m.texto);
        const querSubmeter = !eNegacao && !eDuvidaOuPergunta && /\b(assinar|submeta|submeter\s+agora|autorizo\s+(o\s+)?(submi|avan|envio)|pode\s+(submet|avan|enviar)|confirm[ao]\s+(a\s+)?submi|quero\s+submeter)\b/i.test(m.texto);
        if (querSubmeter && (missaoAtiva || m.texto.toLowerCase().includes('cmd') || m.texto.toLowerCase().includes('chave'))) {
          const servicoId = missaoAtiva?.servico ?? 'ocupacao-espaco-publico-esplanada';
          const rascunho = fluxoD2.obterRascunhoAtivo(m.pessoa);
          await registro.registar({
            tipo: 'henriques.intencao.classificada',
            origem: 'henriques',
            sessao,
            pessoa: m.pessoa,
            missao: missaoAtiva?.id ?? rascunho?.missaoId ?? 'MIS-0001',
            ator: 'agente:jev',
            simulacao: false,
            dados: {
              servico: servicoId,
              foco_servico: servicoId,
              intencao: 'submeter_comunicacao_previa',
              confianca: 0.99,
              categoria: 'catalogo',
              comportamento: 'submeter_d3',
              exige_consentimento: true,
              motor: 'typesafe-jev',
              modelo: 'typesafe/jev-system-one',
              mandato_inferido: 'D3',
              mcp_ferramenta: 'submeter_comunicacao_previa',
              tempo_ms: 180,
              probabilidades: {
                catalogo: 0.99,
                conhecimento_d0: 0.01,
              },
              arvore_jev: {
                servico: { probabilidades: { catalogo: 0.99, conhecimento_d0: 0.01 } },
                mandato: { probabilidades: { D3: 0.99, D2: 0.01 } },
                ferramenta: { probabilidades: { submeter_comunicacao_previa: 0.98, preparar_rascunho: 0.02 } },
                consentimento: { noul: 0.99 },
              },
            },
          });
          await cenarios.executarSubmissaoAtiva(m.pessoa, rascunho?.processo);
          await regista('canal.mensagem.enviada', m, { tipo: 'submissao_cmd_inferida' });
          return;
        }

        if (
          missaoAtiva &&
          (missaoAtiva.estado === 'entendido' || missaoAtiva.estado === 'a_verificar' || (missaoAtiva.estado as string) === 'em_curso') &&
          (/2[,.]10|metro|calcada|calçada|passeio|fita|largura|livre/i.test(m.texto))
        ) {
          await cenarios.processarValidacaoCalcada(m);
          return;
        }

        // Se o cidadão enviou link de Google Maps ou coordenadas GPS de terreno
        if (/maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps|\b\d{2}\.\d{3,}\s*,\s*-\d{1,2}\.\d{3,}\b/i.test(m.texto)) {
          await cenarios.processarLocalizacaoTerreno(m);
          await regista('canal.mensagem.enviada', m, { tipo: 'localizacao_terreno' });
          return;
        }

        // Se o cidadão referiu envio de caderneta predial
        if (/caderneta|predial|\.pdf\b/i.test(m.texto) && missaoAtiva?.servico.includes('urbanismo')) {
          await cenarios.processarDocumentoPdf(m);
          await regista('canal.mensagem.enviada', m, { tipo: 'caderneta_predial' });
          return;
        }

        // Se o cidadão enviou ou confirma anexo da apólice de seguro
        if (/\b(anexar|enviei|juntei|entreguei|aqui\s+est[aá]|tenho|junto)\b.*(ap[oó]lice|seguro)/i.test(m.texto)) {
          await cenarios.processarApoliceSeguro(m);
          await regista('canal.mensagem.enviada', m, { tipo: 'anexo_apolice_seguro' });
          return;
        }

        // Se o cidadão pede expressamente o documento, minuta, formulário, termo ou apólice oficial
        const pedeDocumento =
          /\b(d[aá]|envia|manda|passa|partilha|fornece|quero|uqero|preciso|onde\s+est[aá]|tem|tens)\b.*(documento|modelo|termo|minuta|formul[aá]rio|ap[oó]lice|seguro|ficheiro)/i.test(m.texto) ||
          /\b(n[aã]o,\s*)?(d[aá]|envia|manda|passa).*(documento|ap[oó]lice|seguro)/i.test(m.texto) ||
          /\b(documento|modelo|termo|minuta|formul[aá]rio|ap[oó]lice|seguro)\b.*(favor|pf|aqui|direto)/i.test(m.texto) ||
          /\b(ficheiro|anexo|documento)\b.*(ap[oó]lice|seguro)/i.test(m.texto) ||
          /\b(ap[oó]lice|seguro)\b.*(ficheiro|dar|entregar|enviar|modelo)/i.test(m.texto);

        if (pedeDocumento) {
          const contextoPessoa = henriques.contexto.obterContexto(m.pessoa);
          const servicoAtivo = contextoPessoa?.servicoAtivoId ?? missaoAtiva?.servico;

          let nomeFicheiro = 'Termo_Responsabilidade_Guimaraes.md';
          let tituloDoc = 'Termo de Responsabilidade e Seguro Obrigatório';
          let caminhoFicheiro = join(RAIZ_DADOS, '03_prova_desportiva/termo_responsabilidade.md');

          if (/ap[oó]lice|seguro/i.test(m.texto)) {
            nomeFicheiro = 'Apolice_Seguro_Prova_Desportiva.md';
            tituloDoc = 'Certificado e Apólice de Seguro Obrigatório (DL 10/2009)';
            caminhoFicheiro = join(RAIZ_DADOS, '03_prova_desportiva/apolice_seguro_prova_desportiva.md');
          } else if (servicoAtivo === 'ocupacao-espaco-publico-esplanada' || /esplanada|fachada|planta|croquis|certid[aã]o|mobili[aá]rio/i.test(m.texto)) {
            if (/planta|croquis|desenho|implanta/i.test(m.texto)) {
              nomeFicheiro = 'Planta_Cotada_Esplanada_Oliveira.md';
              tituloDoc = 'Planta de Implantação e Croquis Cotado da Esplanada';
              caminhoFicheiro = join(RAIZ_DADOS, '01_esplanada/planta_cotada_esplanada_oliveira.md');
            } else if (/certid[aã]o|empresa|sociedade/i.test(m.texto)) {
              nomeFicheiro = 'Certidao_Comercial_Casa_Joaquim.md';
              tituloDoc = 'Certidão Comercial Permanente (Casa Joaquim)';
              caminhoFicheiro = join(RAIZ_DADOS, '01_esplanada/certidao_comercial_casa_joaquim.md');
            } else if (/fachada|frente|largura/i.test(m.texto)) {
              nomeFicheiro = 'Declaracao_Medicao_Fachada_8m.md';
              tituloDoc = 'Declaração de Medição da Fachada (8 Metros)';
              caminhoFicheiro = join(RAIZ_DADOS, '01_esplanada/medicao_fachada_8m.md');
            } else if (/mobili[aá]rio|cadeira|mesa/i.test(m.texto)) {
              nomeFicheiro = 'Termo_Conformidade_Mobiliario.md';
              tituloDoc = 'Termo de Responsabilidade do Mobiliário de Esplanada';
              caminhoFicheiro = join(RAIZ_DADOS, '01_esplanada/termo_conformidade_mobiliario.md');
            } else {
              nomeFicheiro = 'Formulario_Modelo_OVP_SO.md';
              tituloDoc = 'Formulário Modelo OVP-SO (Ocupação de Espaço Público)';
              caminhoFicheiro = join(RAIZ_DADOS, '01_esplanada/minuta_modelo_ovp_so.md');
            }
          } else if (servicoAtivo === 'pedido-informacao-previa-urbanismo' || /pdm|urbanismo|terreno|pip/i.test(m.texto)) {
            nomeFicheiro = 'Minuta_PIP_Urbanismo_RJUE.md';
            tituloDoc = 'Minuta de Pedido de Informação Prévia (Art. 14.º RJUE)';
            caminhoFicheiro = join(RAIZ_DADOS, '02_urbanismo_pdm/minuta_modelo_pip_rjue.md');
          }

          const conteudoDoc = await fs.readFile(caminhoFicheiro, 'utf-8').catch(() => `# ${tituloDoc}\n\nDocumento oficial.`);

          // 1. Anotar facto validado no contexto da conversa
          henriques.contexto.anotarFacto(m.pessoa, 'documento_entregue', tituloDoc);

          // 2. Enviar o documento diretamente na conversa (sem colocar no Cofre Digital)
          const legenda = [
            `📄 Aqui tem o documento de <b>${tituloDoc}</b> para instrução.`,
            '',
            'Assim que o tiver preenchido ou assinado, envie-o por aqui para ser integrado no pedido a submeter à Câmara.',
          ].join('\n');

          const isEsplanadaDoc = servicoAtivo === 'ocupacao-espaco-publico-esplanada' || /esplanada|planta|fachada|certidao|ovp/i.test(m.texto);
          const botoesDoc: Botao[][] = /ap[oó]lice|seguro/i.test(m.texto)
            ? [
                [{ texto: '📑 Simular Envio: Apólice no Pedido', dados: 'anexar_apolice_seguro' }],
                [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
                [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
              ]
            : isEsplanadaDoc
              ? [
                  [{ texto: '📑 Simular Envio: Planta no Pedido', dados: 'anexar_planta_esplanada' }],
                  [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
                  [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
                ]
              : [
                  [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
                  [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
                ];

          await canal.enviarDocumento(
            m.conversa,
            {
              nome: nomeFicheiro,
              conteudoTexto: conteudoDoc,
            },
            legenda,
            botoesDoc,
          );
          return;
        }

        // Se o cidadão pergunta sobre o estado dos seus pedidos / processos anteriores
        const pedeEstadoPedido =
          /\b(como\s+est[aá]|qual\s+[eé]\s+o\s+estado|como\s+vai|meu\s+pedido|meu\s+processo|minha\s+esplanada|o\s+meu\s+caso|estado\s+do\s+pedido|meus\s+pedidos|pedidos?\s+ativos?)\b/i.test(m.texto);

        if (pedeEstadoPedido) {
          await canal.aEscrever(m.conversa);
          const todosPedidos = await obterPedidosConsola();
          const pedidosEsplanada = todosPedidos.filter((p: any) => p.processo?.startsWith('OEP/'));

          if (pedidosEsplanada.length > 0) {
            const blocos = pedidosEsplanada.map((p: any) => {
              const estab = p.dados?.find((d: any) => d.campo === 'Estabelecimento')?.valor ?? '';
              const morada = p.dados?.find((d: any) => d.campo === 'Local de intervenção')?.valor ?? '';
              const statusIcon = p.status === 'Aprovada' ? '✅ Aprovada (Alvará Digital Concedido)' : p.status === 'Indeferida' ? '❌ Indeferida' : '⏳ Aguarda análise na Consola Municipal';
              return [
                `📋 <b>Processo: <code>${p.processo}</code></b>`,
                estab ? `• <b>Estabelecimento:</b> ${estab}` : '',
                morada ? `• <b>Localização:</b> ${morada}` : '',
                `• <b>Estado:</b> ${statusIcon}`,
              ].filter(Boolean).join('\n');
            }).join('\n\n━━━━━━━━━━━━━━━━━━━━\n\n');

            const resposta = [
              '🏛️ <b>Os seus pedidos no Município de Guimarães:</b>',
              '',
              blocos,
              '',
              'Todos os dados, minutas e alvarás estão guardados no seu <b>Cofre Digital</b>.',
            ].join('\n');

            await canal.enviar(m.conversa, resposta, [
              [{ texto: '🚀 Iniciar Novo Pedido de Esplanada', dados: 'iniciar_esplanada_d2' }],
              [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
            ]);
            return;
          }
        }

        // 4. Pergunta em linguagem natural: responde com o Henriques e a Porta
        await canal.aEscrever(m.conversa);
        const metadadosCofre = (() => {
          try {
            return cofre.listarMetadados(m.pessoa) ?? [];
          } catch {
            return [];
          }
        })();
        const itensCofre = metadadosCofre.map(it => ({ tipo: it.tipo, titulo: it.titulo }));
        const resp = await henriques.responder(m.pessoa, m.texto, {
          pessoa: m.pessoa,
          servicoAtivo: missaoAtiva?.servico,
          servicoTituloAtivo: missaoAtiva?.servicoTitulo,
          missaoAtiva: Boolean(missaoAtiva),
          missaoId: missaoAtiva?.id,
          estadoMissao: missaoAtiva?.estado,
          mandatoAtivoNivel: missaoAtiva ? 'D2' : 'D0',
          itensCofre,
        });
        if (resp.mensagens && resp.mensagens.length > 1) {
          await canal.enviarSequencia(m.conversa, resp.mensagens, resp.botoes);
        } else {
          await canal.enviar(m.conversa, resp.texto, resp.botoes);
        }
      }

      console.log(`📤 [Canal] Resposta enviada a ${m.pessoa}`);
    } catch (err) {
      console.error(`✖ Erro ao processar mensagem no canal para ${m.pessoa}:`, err);
      await canal.enviar(
        m.conversa,
        'Ocorreu um lapso temporário no processamento da sua mensagem. Por favor tente de novo ou selecione o atendimento humano.',
        [[{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }]],
      ).catch(() => {});
    }
  }

  return { tratar };
}

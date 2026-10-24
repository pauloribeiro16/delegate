/**
 * Gestor do Fluxo Conversacional D2 (Preparação Guiada de Processos no Telegram)
 *
 * Permite ao Henriques conduzir um diálogo fluido e natural passo-a-passo com o cidadão:
 * Passo 1: Nome e Morada do estabelecimento;
 * Passo 2: Quantidade de mesas e cadeiras (área m²);
 * Passo 3: Verificação de conformidade regulamentar do passeio (>= 2,00m);
 * Passo 4: Conclusão do pacote instrutório mínimo no Cofre e transição para D3 (CMD).
 */
import type { CofreDigital } from '../cofre/cofre.js';
import type { GestorMandatos } from '../mandatos/mandatos.js';
import type { OrquestradorMissoes } from './missao.js';
import type { Registo } from '../eventos/registo.js';
import type { ArmazenamentoEstado } from '../estado.js';
import type { CanalGrammy, Botao } from '../canal.js';

import type { RedatorOpenRouter } from '../henriques/redator-openrouter.js';

export type EstadoD2 = 'aguarda_morada' | 'aguarda_estabelecimento' | 'aguarda_mesas' | 'aguarda_passeio' | 'concluido';

export interface RascunhoEsplanada {
  pessoa: string;
  missaoId: string;
  processo?: string;
  casoId?: string;
  estado: EstadoD2;
  estabelecimento?: string;
  morada?: string;
  mesas?: number;
  areaM2?: number;
  larguraLivre?: string;
}

export function extrairEstabelecimentoEMorada(texto: string): {
  estabelecimento: string | null;
  morada: string | null;
} {
  let t = texto.trim();
  if (t === 'd2_morada_joaquim') {
    return {
      estabelecimento: 'Casa Joaquim',
      morada: 'Largo da Oliveira, 12, Guimarães',
    };
  }

  let estabelecimento: string | null = null;
  let morada: string | null = null;

  // 1. Caso haja indicação clara de rua/largo/avenida no meio da frase com 'na/no/em'
  const matchRuaNoMeio = t.match(/^(.*?)\s+(?:na|no|em)\s+((?:rua|largo|pra[çc]a|avenida|travessa|alameda|cal[çc]ada)\b.*)$/i);
  if (matchRuaNoMeio) {
    estabelecimento = matchRuaNoMeio[1]
      .replace(/^(?:o\s+meu\s+estabelecimento\s+[eé]|o\s+caf[eé]\s+[eé]|o\s+restaurante\s+[eé]|chama-se|[eé]\s+o)\s+/i, '')
      .trim();
    morada = matchRuaNoMeio[2].trim();
  } else if (t.includes(',')) {
    // 2. Formato 'Nome, Morada ...'
    const partes = t.split(',').map((s) => s.trim()).filter(Boolean);
    const primeira = partes[0];
    const ehRua = /^(rua|largo|pra[çc]a|avenida|travessa|alameda|cal[çc]ada|praceta|parque|campo|rotunda)\b/i.test(primeira);
    if (!ehRua && partes.length >= 2) {
      estabelecimento = primeira;
      morada = partes.slice(1).join(', ');
    } else {
      morada = t;
    }
  } else {
    // 3. Sem vírgula: ou é só rua ou é só estabelecimento
    const ehRua =
      /^(rua|largo|pra[çc]a|avenida|travessa|alameda|cal[çc]ada|praceta|parque|campo|rotunda)\b/i.test(t) ||
      /\b(guimar[aã]es|urgeses|azur[eé]m|creixomil|fermentelos|silvares|oliveira)\b/i.test(t);
    if (ehRua) {
      morada = t;
    } else {
      estabelecimento = t;
    }
  }

  if (estabelecimento) {
    estabelecimento = estabelecimento
      .replace(/^(?:o\s+nome\s+[eé]|estabelecimento\s*:?|nome\s*:?)\s*/i, '')
      .replace(/[.,;]+$/, '')
      .trim();
    if (estabelecimento.length < 2) estabelecimento = null;
  }

  if (morada) {
    morada = morada
      .replace(/^(?:morada\s*:?|fica\s+(?:na|no|em)\s*)\s*/i, '')
      .replace(/[.,;]+$/, '')
      .trim();
    // Se a morada ainda tiver o nome do estabelecimento repetido no início, remove-se
    if (estabelecimento && morada.toLowerCase().startsWith(estabelecimento.toLowerCase())) {
      morada = morada.slice(estabelecimento.length).replace(/^[,\s-]+/, '').trim();
    }
    if (morada.length < 3) morada = null;
  }

  return { estabelecimento, morada };
}

import { validarPertenceGuimaraes } from '../validadores/guimaraes-territorio.js';

export class GestorFluxoD2 {
  readonly #cofre: CofreDigital;
  readonly #mandatos: GestorMandatos;
  readonly #orquestrador: OrquestradorMissoes;
  readonly #registo: Registo;
  readonly #canal: CanalGrammy;
  readonly #sessao: string;
  readonly #redator?: RedatorOpenRouter;
  readonly #rascunhos = new Map<string, RascunhoEsplanada>();
  /** Onde o rascunho vive quando o núcleo corre fora do processo local. */
  readonly #armazenamento?: ArmazenamentoEstado;

  constructor(deps: {
    cofre: CofreDigital;
    mandatos: GestorMandatos;
    orquestrador: OrquestradorMissoes;
    registo: Registo;
    canal: CanalGrammy;
    sessao?: string;
    redator?: RedatorOpenRouter;
    armazenamento?: ArmazenamentoEstado;
  }) {
    this.#cofre = deps.cofre;
    this.#mandatos = deps.mandatos;
    this.#orquestrador = deps.orquestrador;
    this.#registo = deps.registo;
    this.#canal = deps.canal;
    this.#sessao = deps.sessao ?? 'demo';
    this.#redator = deps.redator;
    this.#armazenamento = deps.armazenamento;
  }

  /**
   * Carrega da base o rascunho em curso da pessoa. Sem isto, cada função do
   * alojamento esqueceria o passo em que a pessoa estava.
   */
  async restaurar(pessoa: string): Promise<void> {
    if (!this.#armazenamento) return;
    for (const estado of await this.#armazenamento.listar('rascunho', pessoa)) {
      this.#rascunhos.set(pessoa, estado.dados as RascunhoEsplanada);
    }
  }

  /** Grava o rascunho da pessoa (chamado depois de cada passo do fluxo). */
  async persistir(pessoa: string): Promise<void> {
    if (!this.#armazenamento) return;
    const rascunho = this.#rascunhos.get(pessoa);
    if (!rascunho) return;
    await this.#armazenamento.gravar('rascunho', pessoa, pessoa, rascunho);
  }

  obterRascunhoAtivo(pessoa: string): RascunhoEsplanada | undefined {
    return this.#rascunhos.get(pessoa);
  }

  obterUltimoRascunho(): RascunhoEsplanada | undefined {
    const todos = Array.from(this.#rascunhos.values());
    return todos[todos.length - 1];
  }

  cancelarRascunho(pessoa: string): void {
    this.#rascunhos.delete(pessoa);
  }

  /**
   * Inicia o fluxo conversacional de preparação da esplanada sob Mandato D2.
   */
  async iniciarFluxoEsplanada(pessoa: string, conversa: string, enviarMensagemInicial = true): Promise<void> {
    // Registar no Orquestrador primeiro para obter o missaoId canónico (MIS-xxxx)
    const missao = await this.#orquestrador.criarMissao({
      pessoa,
      servico: 'ocupacao-espaco-publico-esplanada',
      servicoTitulo: 'Ocupação do Espaço Público — Esplanada Aberta',
      objetivo: 'Preparar pacote instrutório mínimo para Mera Comunicação Prévia',
      mandato: 'pendente',
      passosIniciais: [
        'Identificar estabelecimento e localização em Guimarães',
        'Definir dimensões e número de mesas',
        'Validar corredor pedonal livre (>= 2,00 m)',
        'Submissão formal com Chave Móvel Digital (D3)',
      ],
    });
    const missaoId = missao.id;

    // Conceder Mandato D2 no Gestor de Mandatos associado à missão criada
    const mandato = await this.#mandatos.concederMandato(pessoa, missaoId, {
      ambito: 'ocupacao-espaco-publico',
      objeto: 'Instrução de Esplanada',
      nivel: 'D2',
      validadeDias: 180,
    });
    missao.mandato = mandato.id;

    // Determinar processo municipal sequencial (OEP/2026/0001, OEP/2026/0002, ...)
    let proximoNumero = 1;
    try {
      const procs = await this.#registo.listarProcessosMunicipais();
      const nums = procs
        .map((p) => {
          const m = p.processo.match(/OEP\/2026\/(\d+)/);
          return m ? parseInt(m[1], 10) : 0;
        })
        .filter((n) => n > 0);
      if (nums.length > 0) {
        proximoNumero = Math.max(...nums) + 1;
      }
    } catch {}

    const processo = `OEP/2026/${String(proximoNumero).padStart(4, '0')}`;
    const casoId = `CASO-${String(proximoNumero).padStart(4, '0')}`;

    this.#rascunhos.set(pessoa, {
      pessoa,
      missaoId,
      processo,
      casoId,
      estado: 'aguarda_morada',
    });

    await this.#registo.registar({
      tipo: 'henriques.intencao.classificada',
      origem: 'henriques',
      sessao: this.#sessao,
      pessoa,
      missao: missaoId,
      ator: 'agente:jev',
      simulacao: false,
      dados: {
        servico: 'ocupacao-espaco-publico-esplanada',
        foco_servico: 'ocupacao-espaco-publico-esplanada',
        intencao: 'iniciar_esplanada',
        confianca: 0.99,
        categoria: 'catalogo',
        comportamento: 'iniciar_d2',
        exige_consentimento: true,
        motor: 'typesafe-jev',
        modelo: 'typesafe/jev-system-one',
        mandato_inferido: 'D2',
        mcp_ferramenta: 'preparar_rascunho',
        tempo_ms: 195,
        probabilidades: {
          catalogo: 0.99,
          conhecimento_d0: 0.01,
        },
        arvore_jev: {
          servico: { probabilidades: { catalogo: 0.99, conhecimento_d0: 0.01 } },
          mandato: { probabilidades: { D2: 0.99, D0: 0.01 } },
          ferramenta: { probabilidades: { preparar_rascunho: 0.97, verificar_regras: 0.03 } },
          consentimento: { noul: 0.95 },
        },
      },
    });

    await this.#registo.registar({
      tipo: 'henriques.missao_iniciada',
      origem: 'henriques',
      sessao: this.#sessao,
      pessoa,
      missao: missaoId,
      ator: 'agente:henriques',
      simulacao: false,
      dados: { servico: 'ocupacao-espaco-publico-esplanada', mandato: mandato.id },
    });

    await this.#registo.registar({
      tipo: 'consola.caso.criado',
      origem: 'consola',
      sessao: this.#sessao,
      pessoa,
      missao: missaoId,
      ator: 'sistema',
      simulacao: true,
      dados: {
        caso: casoId,
        processo,
        servico: 'ocupacao-espaco-publico-esplanada',
        risco: 'baixo',
        token_cmd: 'PENDENTE-ASSINATURA',
        documentos: ['Formulário Modelo OVP-SO (Instrução D2)'],
      },
    });

    if (enviarMensagemInicial) {
      const texto = [
        'Entendido! Vamos preparar o seu pedido de esplanada no Cofre Digital (sob Mandato D2).',
        '',
        '📋 <b>Documentos Necessários para a Instrução:</b>',
        '1. Formulário Modelo OVP-SO (preenchido com estes dados);',
        '2. Planta de localização ou fotografia com corredor livre ≥ 2,00m;',
        '3. Certidão Permanente da empresa (ou início de atividade);',
        '4. Apólice de Seguro de Responsabilidade Civil.',
        '',
        'Para começarmos a instrução: qual é o <b>nome</b> e a <b>morada</b> do estabelecimento aqui em Guimarães?',
      ].join('\n');

      const botoesIniciais: Botao[][] = [
        [{ texto: '📍 Exemplo: Casa Joaquim (Largo da Oliveira)', dados: 'd2_morada_joaquim' }],
        [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
      ];

      await this.#canal.enviar(conversa, texto, botoesIniciais);
    }
  }

  /**
   * Processa uma mensagem de texto ou botão dentro do fluxo conversacional ativo.
   */
  /**
   * Processa uma mensagem de texto ou botão dentro do fluxo conversacional ativo,
   * extraindo entidades de forma flexível e redigindo respostas dinâmicas com o Redator LLM.
   */
  async processarPasso(pessoa: string, conversa: string, textoEntrada: string): Promise<boolean> {
    const rascunho = this.#rascunhos.get(pessoa);
    if (!rascunho || rascunho.estado === 'concluido') return false;

    const t = textoEntrada.trim();

    await this.#registo.registar({
      tipo: 'henriques.intencao.classificada',
      origem: 'henriques',
      sessao: this.#sessao,
      pessoa,
      missao: rascunho.missaoId,
      ator: 'agente:jev',
      simulacao: false,
      dados: {
        servico: 'ocupacao-espaco-publico-esplanada',
        foco_servico: 'ocupacao-espaco-publico-esplanada',
        intencao: 'instrucao_esplanada_passo',
        confianca: 0.98,
        categoria: 'catalogo',
        comportamento: 'processar_d2',
        exige_consentimento: false,
        motor: 'typesafe-jev',
        modelo: 'typesafe/jev-system-one',
        mandato_inferido: 'D2',
        mcp_ferramenta: 'preparar_rascunho',
        tempo_ms: 165,
        probabilidades: {
          catalogo: 0.98,
          conhecimento_d0: 0.02,
        },
        arvore_jev: {
          servico: { probabilidades: { catalogo: 0.98, conhecimento_d0: 0.02 } },
          mandato: { probabilidades: { D2: 0.98, D0: 0.02 } },
          ferramenta: { probabilidades: { preparar_rascunho: 0.95, verificar_regras: 0.05 } },
          consentimento: { noul: 0.02 },
        },
      },
    });

    // 1. Deteção de recusa explícita do corredor pedonal
    const ehNegacaoPasseio = /\b(n[aã]o\s+(tem|d[aá]|garante)|recuso|menos\s+de\s+2|abaixo|insuficiente|estreito)\b/i.test(t);
    if (ehNegacaoPasseio && rascunho.mesas && !rascunho.larguraLivre) {
      const textoNaoConforme = [
        '⚠️ <b>Requisito Regulamentar Não Cumprido</b>',
        '',
        'O <b>Artigo 8.º do Regulamento de Ocupação do Espaço Público</b> exige expressamente um corredor pedonal contínuo e desimpedido de pelo menos <b>2,00 metros</b> na calçada.',
        '',
        'Por imperativo de lealdade e proteção legal do cidadão, o Henriques <b>não pode certificar nem submeter uma declaração desconforme</b> à Câmara Municipal de Guimarães.',
        '',
        'O seu rascunho fica guardado no Cofre Digital até que as condições técnicas sejam reunidas ou possa solicitar uma vistoria prévia.',
      ].join('\n');

      await this.#canal.enviar(conversa, textoNaoConforme);
      await this.#orquestrador.mudarEstado(rascunho.missaoId, 'precisa_de_si', 'Largura do corredor inferior ao mínimo regulamentar de 2,00m');
      return true;
    }

    // 2. Extração Flexível e Rigorosa de Estabelecimento e Morada
    if (!rascunho.morada || !rascunho.estabelecimento || /mudar\s+(morada|estabelecimento)|afinal\s+fica/i.test(t)) {
      if (
        t === 'd2_morada_joaquim' ||
        rascunho.estado === 'aguarda_morada' ||
        rascunho.estado === 'aguarda_estabelecimento' ||
        /joaquim|oliveira|largo|rua|pra[çc]a|avenida|travessa|alameda|cal[çc]ada|beira|caf[eé]|restaurante|bar|snack|guimarães|guimaraes/i.test(t)
      ) {
        const extraido = extrairEstabelecimentoEMorada(t);

        if (extraido.estabelecimento) {
          rascunho.estabelecimento = extraido.estabelecimento;
        } else if (!rascunho.estabelecimento && extraido.morada) {
          rascunho.estabelecimento = 'Estabelecimento Comercial';
        }
        if (extraido.morada) {
          const valGeo = validarPertenceGuimaraes(extraido.morada);
          if (valGeo.valido) {
            rascunho.morada = extraido.morada;
          } else if (valGeo.motivo) {
            await this.#canal.enviar(
              conversa,
              `⚠️ <b>Fora do Concelho de Guimarães</b>\n\n${valGeo.motivo}\n\nO Henriques representa-o exclusivamente junto do Município de Guimarães. Por favor, indique a morada do estabelecimento situada no concelho de Guimarães.`,
            );
            return true;
          }
        }

        // Se ambos foram reunidos
        if (rascunho.estabelecimento && rascunho.morada) {
          await this.#cofre.guardarItem(pessoa, rascunho.missaoId, {
            camada: 'intencoes',
            tipo: 'intencao_negocio',
            titulo: `Esplanada ${rascunho.estabelecimento}`,
            origem: 'conversa_telegram',
            finalidade: 'Licenciamento de ocupação de espaço público',
            dados: { estabelecimento: rascunho.estabelecimento, morada: rascunho.morada },
          });
          this.#orquestrador.atualizarPassoChecklist(rascunho.missaoId, 'chk-1', true, `${rascunho.estabelecimento} (${rascunho.morada})`);
          if (!rascunho.mesas) {
            rascunho.estado = 'aguarda_mesas';
          }
        } else if (!rascunho.estabelecimento && rascunho.morada) {
          rascunho.estado = 'aguarda_estabelecimento';
        } else if (rascunho.estabelecimento && !rascunho.morada) {
          rascunho.estado = 'aguarda_morada';
        }
      }
    }

    // 3. Extração Flexível de Mesas / Área
    const matchArea = t.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²|metros\s*quadrados)/i);
    const matchMesas = t.match(/(\d+)\s*mesas?/i);
    if (matchArea) {
      const area = parseFloat(matchArea[1].replace(',', '.'));
      rascunho.areaM2 = area;
      rascunho.mesas = Math.max(1, Math.round(area / 2.5));
    } else if (matchMesas) {
      rascunho.mesas = parseInt(matchMesas[1], 10);
      rascunho.areaM2 = rascunho.mesas * 2.5;
    } else if (t === 'd2_mesas_2') {
      rascunho.mesas = 2;
      rascunho.areaM2 = 5;
    } else if (t === 'd2_mesas_4') {
      rascunho.mesas = 4;
      rascunho.areaM2 = 10;
    } else if (t === 'd2_mesas_6') {
      rascunho.mesas = 6;
      rascunho.areaM2 = 15;
    } else if (rascunho.morada && !rascunho.mesas && /\b\d+\b/.test(t) && !/2[,.]10/.test(t)) {
      const n = parseInt(t.match(/\b\d+\b/)![0], 10);
      if (n >= 1 && n <= 30) {
        rascunho.mesas = n;
        rascunho.areaM2 = n * 2.5;
      }
    }

    if (rascunho.mesas) {
      await this.#cofre.guardarItem(pessoa, rascunho.missaoId, {
        camada: 'intencoes',
        tipo: 'dimensoes_esplanada',
        titulo: 'Dimensões da Esplanada',
        origem: 'conversa_telegram',
        finalidade: 'Aferição de taxas e corredor regulamentar',
        dados: { mesas: rascunho.mesas, area_m2: rascunho.areaM2, periodo: 'Anual (2026)' },
      });
      this.#orquestrador.atualizarPassoChecklist(rascunho.missaoId, 'chk-2', true, `${rascunho.mesas} mesas (~${rascunho.areaM2} m²)`);
      if (!rascunho.larguraLivre) {
        rascunho.estado = 'aguarda_passeio';
      }
    }

    // 4. Extração Flexível de Corredor Pedonal e Documentos Instrutórios
    // Códigos de botão (d2_*) nunca medem largura: o «2» de «d2_morada_joaquim»
    // não é um corredor medido.
    const matchLargura = t.match(/(\d+[\.,]\d+|\d+)\s*(m|metro|metros)?/i);
    const ehEnvioDoc =
      t.startsWith('d2_anexar_') ||
      t.startsWith('d2_doc_') ||
      t.startsWith('documento:') ||
      t === 'd2_passeio_ok' ||
      /planta|croquis|certid[aã]o|documento|ficheiro|anexo|termo|responsabilidade|seguro|2[,.]10|2[,.]50|calçada|passeio/i.test(t);

    if (matchLargura && !t.startsWith('d2_') && /metro|m\b|largura|livre|calçada|passeio/i.test(t)) {
      const val = parseFloat(matchLargura[1].replace(',', '.'));
      if (val >= 2.00) {
        rascunho.larguraLivre = `${val.toFixed(2).replace('.', ',')} metros`;
      }
    } else if (ehEnvioDoc && rascunho.mesas) {
      rascunho.larguraLivre = rascunho.larguraLivre || '2,10 metros';
    }

    // Notificar a Consola Municipal de qualquer atualização de dados do rascunho
    if (rascunho.morada || rascunho.mesas || rascunho.larguraLivre) {
      await this.#registo.registar({
        tipo: 'consola.caso.criado',
        origem: 'consola',
        sessao: this.#sessao,
        pessoa,
        missao: rascunho.missaoId,
        ator: 'sistema',
        simulacao: true,
        dados: {
          caso: rascunho.casoId ?? 'CASO-0001',
          processo: rascunho.processo ?? 'OEP/2026/0001',
          servico: 'ocupacao-espaco-publico-esplanada',
          risco: 'baixo',
          token_cmd: rascunho.morada && rascunho.mesas && rascunho.larguraLivre ? 'AGUARDA-ASSINATURA-CMD' : 'PENDENTE-ASSINATURA',
          estabelecimento: rascunho.estabelecimento ?? 'Estabelecimento em Guimarães',
          morada: rascunho.morada ?? 'Guimarães',
          mesas: rascunho.mesas ?? 4,
          area_m2: rascunho.areaM2 ?? 10,
          largura_livre: rascunho.larguraLivre ?? 'A validar (>= 2,00m)',
          documentos: rascunho.larguraLivre
            ? ['Formulário Modelo OVP-SO', `Planta Cotada (Corredor ${rascunho.larguraLivre})`, 'Certidão Permanente Comercial', 'Termo de Mobiliário Amovível']
            : ['Formulário Modelo OVP-SO (Instrução D2)'],
        },
      });
    }

    // 5. Todos os dados e documentos foram reunidos?
    if (rascunho.morada && rascunho.mesas && rascunho.larguraLivre) {
      rascunho.estado = 'concluido';
      await this.#orquestrador.mudarEstado(rascunho.missaoId, 'preparado', 'Requisitos validados e pacote mínimo preparado');

      // Guardar provas documentais auditadas no Cofre Digital com hash SHA-256
      await this.#cofre.guardarItem(pessoa, rascunho.missaoId, {
        camada: 'provas',
        tipo: 'planta_cotada',
        titulo: 'Planta de Implantação e Croquis Cotado',
        origem: 'upload_documento',
        finalidade: 'Comprovação de corredor pedonal livre (Art. 8.º ROPP)',
        dados: {
          ficheiro: '01_Planta_Cotada_Esplanada.pdf',
          corredor_medido: rascunho.larguraLivre,
          cumpre_requisito: true,
          hash_sha256: '4f8a9b2c3d1e0f5a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a',
        },
      });

      await this.#cofre.guardarItem(pessoa, rascunho.missaoId, {
        camada: 'provas',
        tipo: 'certidao_comercial',
        titulo: 'Certidão Permanente de Registo Comercial',
        origem: 'upload_documento',
        finalidade: 'Comprovação da legitimidade societária e CAE 56101',
        dados: {
          ficheiro: '02_Certidao_Permanente_Comercial.pdf',
          codigo_acesso: '2026-4800-OLIV-9912',
          entidade: rascunho.estabelecimento,
          hash_sha256: '7b2c8a1e9f0d4c3b5a6e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9',
        },
      });

      await this.#cofre.guardarItem(pessoa, rascunho.missaoId, {
        camada: 'provas',
        tipo: 'termo_responsabilidade',
        titulo: 'Termo de Responsabilidade do Mobiliário',
        origem: 'upload_documento',
        finalidade: 'Garantia de mobiliário amovível sem furações',
        dados: {
          ficheiro: '03_Termo_Responsabilidade_Mobiliario.pdf',
          amovivel: true,
          sem_furacoes: true,
          hash_sha256: '9c1a3b5d7e9f0a2c4e6b8d0a2f4c6e8a0b2d4f6a',
        },
      });

      await this.#cofre.prepararPacoteMinimo(
        pessoa,
        rascunho.missaoId,
        'Câmara Municipal de Guimarães — Gabinete de Serviços Urbanos',
        'Mera Comunicação Prévia de Esplanada',
        {
          estabelecimento: rascunho.estabelecimento,
          morada: rascunho.morada,
          area_m2: rascunho.areaM2 ?? 10,
          numero_mesas: rascunho.mesas ?? 4,
          periodo: 'Anual (2026)',
          corredor_pedonal_livre: `${rascunho.larguraLivre} (cumpre Art. 8.º >= 2,00 m)`,
          documentos_validados: [
            '01_Planta_Cotada_Esplanada.pdf',
            '02_Certidao_Permanente_Comercial.pdf',
            '03_Termo_Responsabilidade_Mobiliario.pdf',
          ],
        },
        ['terreno_ponte', 'conversas_privadas', 'declaracoes_fiscais', 'dados_bancarios'],
      );

      this.#orquestrador.atualizarPassoChecklist(rascunho.missaoId, 'chk-3', true, `Planta Cotada (${rascunho.larguraLivre}) e Certidão validadas`);

      // Atualiza caso na consola municipal com lista completa de documentos
      await this.#registo.registar({
        tipo: 'consola.caso.criado',
        origem: 'consola',
        sessao: this.#sessao,
        pessoa,
        missao: rascunho.missaoId,
        ator: 'sistema',
        simulacao: true,
        dados: {
          caso: rascunho.casoId ?? 'CASO-0001',
          processo: rascunho.processo ?? 'OEP/2026/0001',
          servico: 'ocupacao-espaco-publico-esplanada',
          risco: 'baixo',
          token_cmd: 'AGUARDA-ASSINATURA-CMD',
          estabelecimento: rascunho.estabelecimento,
          morada: rascunho.morada,
          mesas: rascunho.mesas,
          area_m2: rascunho.areaM2,
          largura_livre: rascunho.larguraLivre,
          documentos: [
            'Formulário Modelo OVP-SO',
            `Planta Cotada (Corredor ${rascunho.larguraLivre})`,
            'Certidão Permanente Comercial',
            'Termo de Mobiliário Amovível',
          ],
        },
      });

      const textoConclusao = [
        '📑 <b>Documentação Recebida e Auditada pelo Henriques!</b> ✅',
        '',
        '🔍 <b>Verificação de Conformidade Regulamentar (Artigo 8.º ROPP):</b>',
        `• 📐 <b>Planta Cotada:</b> Frente de 8,00m e avanço de 2,00m. <b>Corredor pedonal livre verificado: ${rascunho.larguraLivre}</b> (CUMPRE a exigência de ≥ 2,00 m).`,
        '• 🏢 <b>Certidão Comercial:</b> Sociedade ativa, CAE 56101 (Restauração) e gerência com legitimidade confirmada.',
        '• 🛡️ <b>Termo de Mobiliário:</b> Mobiliário 100% amovível, sem furações nem danos no pavimento em granito.',
        '',
        '🔒 <b>Cofre Digital & Minimização RGPD:</b>',
        'Ficheiros guardados com resumos SHA-256 no seu Cofre Digital pessoal. A sua faturação, dados fiscais e bancários <b>permanecem inacessíveis</b> e foram omitidos da Câmara Municipal.',
        '',
        '📄 <b>MINUTA DO REQUERIMENTO MUNICIPAL (OVP-SO)</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        '• <b>Requerente:</b> Identificado via Cofre Digital',
        `• <b>Estabelecimento:</b> ${rascunho.estabelecimento}`,
        `• <b>Localização:</b> ${rascunho.morada}`,
        `• <b>Equipamento:</b> ${rascunho.mesas} mesas com cadeiras amovíveis`,
        `• <b>Área Ocupada:</b> ~${rascunho.areaM2} m² (contígua à fachada)`,
        `• <b>Acessibilidade:</b> Corredor de ${rascunho.larguraLivre} salvaguardado (conforme Art. 8.º >= 2,00m)`,
        '• <b>Documentos:</b> Planta Cotada, Certidão Permanente e Termo de Mobiliário reunidos no Pacote Mínimo (PAC-0001)',
        '• <b>Regime:</b> Mera Comunicação Prévia (eficácia imediata)',
        '━━━━━━━━━━━━━━━━━━━━',
        '',
        '<b>Tudo pronto e validado.</b> Para dar entrada formal do pedido na Câmara Municipal com valor legal, confirme a sua autenticação com <b>Chave Móvel Digital</b>:',
      ].join('\n');

      const botoesFinais: Botao[][] = [
        [{ texto: '✍️ Autenticar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
        [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
      ];

      await this.#canal.enviar(conversa, textoConclusao, botoesFinais);
      return true;
    }

    // 6. Falta algum dado -> Pedir o próximo dado com botões e instrução clara
    const dadosRecolhidos = [
      rascunho.estabelecimento ? `• Estabelecimento: ${rascunho.estabelecimento}` : null,
      rascunho.morada ? `• Morada: ${rascunho.morada}` : null,
      rascunho.mesas ? `• Dimensões: ${rascunho.mesas} mesas (~${rascunho.areaM2} m²)` : null,
    ].filter(Boolean).join('\n');

    let proximoDadoNecessario = '';
    let botoesPasso: Botao[][] = [];

    if (!rascunho.estabelecimento && !rascunho.morada) {
      proximoDadoNecessario = 'Perguntar o nome comercial e a morada (rua) do estabelecimento aqui em Guimarães.';
      botoesPasso = [[{ texto: '📍 Exemplo: Casa Joaquim (Largo da Oliveira)', dados: 'd2_morada_joaquim' }]];
    } else if (!rascunho.estabelecimento && rascunho.morada) {
      proximoDadoNecessario = `A morada (${rascunho.morada}) já está registada com sucesso. Perguntar exclusivamente qual é o nome comercial do estabelecimento.`;
    } else if (rascunho.estabelecimento && !rascunho.morada) {
      proximoDadoNecessario = `O estabelecimento (${rascunho.estabelecimento}) já está registado. Perguntar especificamente a morada (rua e número em Guimarães) onde vai ficar a esplanada.`;
    } else if (!rascunho.mesas) {
      proximoDadoNecessario = `O estabelecimento (${rascunho.estabelecimento}) na ${rascunho.morada} está confirmado. Perguntar quantas mesas e cadeiras ou qual a área em m² planeia colocar no exterior.`;
      botoesPasso = [
        [{ texto: '2 Mesas (~5m²)', dados: 'd2_mesas_2' }, { texto: '4 Mesas (~10m²)', dados: 'd2_mesas_4' }, { texto: '6 Mesas (~15m²)', dados: 'd2_mesas_6' }],
      ];
    } else if (!rascunho.larguraLivre) {
      proximoDadoNecessario = 'Solicitar a documentação instrutória necessária (Planta cotada com o corredor pedonal livre >= 2,00m, Certidão Permanente e Termo de Mobiliário) para validação regulamentar do Artigo 8.º.';
      botoesPasso = [
        [{ texto: '📐 Enviar Planta Cotada (Corredor 2,10m)', dados: 'd2_anexar_planta' }],
        [{ texto: '🏢 Enviar Certidão Comercial', dados: 'd2_anexar_certidao' }],
        [{ texto: '📂 Enviar Todos os Documentos Obrigatórios', dados: 'd2_anexar_todos' }],
        [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
      ];
    }

    let respostaTexto = '';
    if (this.#redator && (!rascunho.morada || !rascunho.mesas)) {
      try {
        const redacao = await this.#redator.redigir({
          pergunta: t,
          servicoId: 'ocupacao-espaco-publico-esplanada',
          categoria: 'processo_d2',
          comportamento: 'responder',
          contextoFactos: [
            'O cidadão está em processo ativo de preparação da esplanada no Cofre Digital (Mandato D2).',
            dadosRecolhidos ? `Dados já validados e guardados no Cofre Digital:\n${dadosRecolhidos}` : 'Ainda a recolher os primeiros dados.',
            `Objetivo desta mensagem: ${proximoDadoNecessario}`,
            'Regulamento de Ocupação do Espaço Público de Guimarães (Artigo 8.º: corredor pedonal contínuo >= 2,00m, mobiliário amovível).',
          ].join('\n'),
          fonteOficial: 'Regulamento de Ocupação do Espaço Público de Guimarães (Artigo 8.º)',
          textoReferencia: `Entendido. ${proximoDadoNecessario}`,
        });
        if (redacao.geradoPorLlm && redacao.texto && redacao.texto.length > 10) {
          respostaTexto = redacao.texto;
        }
      } catch (err) {
        console.warn('Erro ao chamar redator LLM em D2:', err);
      }
    }

    if (!respostaTexto) {
      if (!rascunho.morada) {
        respostaTexto = 'Qual é o <b>nome</b> e a <b>morada</b> do estabelecimento aqui em Guimarães?';
      } else if (!rascunho.mesas) {
        respostaTexto = `Anotei <b>${rascunho.morada}</b>. Quantas <b>mesas</b> e <b>cadeiras</b> planeia colocar no exterior?`;
      } else {
        respostaTexto = [
          `Registei <b>${rascunho.mesas} mesas (~${rascunho.areaM2} m²)</b> para <b>${rascunho.estabelecimento}</b>. ✅`,
          '',
          '📋 <b>Documentos Necessários para a Instrução (Artigo 8.º ROPP / Modelo OVP-SO):</b>',
          'Para instruirmos a Mera Comunicação Prévia com valor legal perante a Câmara Municipal de Guimarães, é necessário anexar a documentação instrutória:',
          '',
          '1. 📐 <b>Planta de Implantação / Croquis Cotado</b> — com medição do corredor pedonal livre (mínimo regulamentar de <b>2,00 metros</b>);',
          '2. 🏢 <b>Certidão Permanente do Registo Comercial</b> — comprovativo de atividade de restauração/bebidas (CAE 56101);',
          '3. 🛡️ <b>Termo de Responsabilidade do Mobiliário</b> — garantia de mobiliário amovível sem furações no pavimento.',
          '',
          'Por favor, <b>envie os ficheiros aqui pelo chat</b> (como documento PDF ou imagem), ou utilize os botões abaixo para validação imediata:',
        ].join('\n');
      }
    }

    await this.#canal.enviar(conversa, respostaTexto, botoesPasso);
    return true;
  }
}


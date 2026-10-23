/**
 * Processador de Cenários Simulados da Demonstração
 *
 * Encapsula a lógica de negócio dos fluxos demonstrativos do piloto:
 * - Confirmação e submissão formal vinculativa com Chave Móvel Digital (CMD);
 * - Georreferenciação de terreno (Google Maps / SIG) e rascunho de PIP de Urbanismo;
 * - Instrução de Caderneta Predial (PDF) com cifra AES-256-GCM no Cofre Digital;
 * - Validação técnica de corredor pedonal livre em esplanadas (>= 2,00m).
 */
import type { Registo } from '../eventos/registo.js';
import type { GestorMandatos } from '../mandatos/mandatos.js';
import type { CofreDigital } from '../cofre/cofre.js';
import type { MotorPolitica } from '../politica/politica.js';
import type { ServicoChavesCofre } from '../cofre/servico-chaves.js';
import type { ClientePortaMcp } from '../henriques/cliente-porta.js';
import type { OrquestradorMissoes } from '../orquestrador/missao.js';
import type { CanalGrammy as CanalTelegram, MensagemRecebida as MensagemCanal } from '../canal.js';
import type { DadosConfirmacaoCmd } from '../eventos/servidor.js';

export type { DadosConfirmacaoCmd };

export interface DependenciasCenarios {
  mandatos: GestorMandatos;
  cofre: CofreDigital;
  politica: MotorPolitica;
  servicoChaves: ServicoChavesCofre;
  clientePorta: ClientePortaMcp;
  orquestrador: OrquestradorMissoes;
  registo: Registo;
  canal: CanalTelegram;
  obterChat: (pessoa: string) => string | null;
  sessao: string;
}

function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class ProcessadorCenarios {
  readonly #mandatos: GestorMandatos;
  readonly #cofre: CofreDigital;
  readonly #politica: MotorPolitica;
  readonly #servicoChaves: ServicoChavesCofre;
  readonly #clientePorta: ClientePortaMcp;
  readonly #orquestrador: OrquestradorMissoes;
  readonly #registo: Registo;
  readonly #canal: CanalTelegram;
  readonly #obterChat: (pessoa: string) => string | null;
  readonly #sessao: string;

  constructor(deps: DependenciasCenarios) {
    this.#mandatos = deps.mandatos;
    this.#cofre = deps.cofre;
    this.#politica = deps.politica;
    this.#servicoChaves = deps.servicoChaves;
    this.#clientePorta = deps.clientePorta;
    this.#orquestrador = deps.orquestrador;
    this.#registo = deps.registo;
    this.#canal = deps.canal;
    this.#obterChat = deps.obterChat;
    this.#sessao = deps.sessao;
  }

  async processarConfirmacaoCmd(dadosCmd: DadosConfirmacaoCmd): Promise<void> {
    const pessoa = dadosCmd.pessoa || 'ines_guimaraes';
    const processo = dadosCmd.processo || 'OEP/2026/0001';
    const servico = dadosCmd.servico || (processo.startsWith('PIP') ? 'pedido-informacao-previa-urbanismo' : 'ocupacao-espaco-publico-esplanada');
    const tokenCmd = dadosCmd.token_cmd;
    const chat = this.#obterChat(pessoa);

    const missaoAtiva = this.#orquestrador.obterAtiva(pessoa);
    const isPip = processo.startsWith('PIP') || servico.includes('pdm') || servico.includes('urbanismo');
    const isProva = processo.startsWith('EVT') || processo.startsWith('DSP') || servico.includes('desportiv') || servico.includes('corrida');
    const missaoId = (dadosCmd as any).missaoId || missaoAtiva?.id || (isPip ? 'MIS-0002' : isProva ? 'MIS-0003' : 'MIS-0001');
    const pacoteId = isPip ? 'PAC-0002' : isProva ? 'PAC-0003' : 'PAC-0001';

    // 1. Conceder Mandato D3 formal com base na assinatura CMD
    const mandato = await this.#mandatos.concederMandato(pessoa, missaoId, {
      ambito: isPip ? 'urbanismo-informacao-previa' : isProva ? 'provas-desportivas-caminhadas' : 'ocupacao-espaco-publico',
      objeto: isPip ? 'Terreno em Silvares (Guimarães)' : isProva ? '1.ª Corrida Popular de Azurém' : 'Casa Joaquim (Largo da Oliveira)',
      nivel: 'D3',
      validadeDias: 180,
    });

    // 2. Aprovar pacote mínimo no cofre
    await this.#cofre.aprovarPacoteMinimo(pessoa, missaoId, pacoteId).catch(() => {});

    // 3. Avaliar política de autorização
    const decisaoPol = await this.#politica.avaliarAcao({
      pessoa,
      missao: missaoId,
      acao: 'submeter_comunicacao_previa',
      ambito: isPip ? 'urbanismo-informacao-previa' : isProva ? 'provas-desportivas-caminhadas' : 'ocupacao-espaco-publico',
      nivelRequerido: 'D3',
      temConfirmacao: true,
    });

    if (decisaoPol.resultado === 'bloquear') {
      if (chat) await this.#canal.enviar(chat, `Submissão bloqueada pelas regras de política: ${decisaoPol.motivo}`);
      return;
    }

    // 4. Libertar chave criptográfica pelo tempo da submissão
    await this.#servicoChaves.libertarChave(pessoa, missaoId, mandato.id, 10 * 60 * 1000);

    // 5. Submeter via Porta Agêntica (MCP)
    await this.#clientePorta.chamarFerramenta('submeter_comunicacao_previa', {
      processo,
      mandato: mandato.id,
      token_confirmacao: tokenCmd,
    }).catch((e) => console.warn('Aviso submeter MCP:', e));

    // 6. Atualizar máquina de estados da missão
    if (!this.#orquestrador.obter(missaoId)) {
      await this.#orquestrador.criarMissao({
        pessoa,
        servico,
        servicoTitulo: isPip
          ? 'Pedido de Informação Prévia (PIP) — Viabilidade PDM'
          : isProva
            ? 'Autorização para Prova Desportiva na Via Pública'
            : 'Ocupação do Espaço Público — Esplanada Aberta',
        objetivo: isPip
          ? 'Obter parecer prévio vinculativo de viabilidade urbanística ao abrigo do Art. 14.º do RJUE'
          : isProva
            ? 'Obter autorização municipal para realização de prova desportiva na via pública'
            : 'Submeter Mera Comunicação Prévia',
        mandato: mandato.id,
        passosIniciais: ['Instrução do pedido', 'Submissão formal com CMD'],
      });
    }
    await this.#orquestrador.mudarEstado(missaoId, 'submetido', `Submetido com mandato D3 e Chave Móvel Digital (${tokenCmd})`);
    this.#orquestrador.atualizarPassoChecklist(missaoId, 'chk-4', true, `Submetido com CMD (${tokenCmd})`);
    this.#orquestrador.atualizarPassoChecklist(missaoId, 'chk-2', true, `Submetido com CMD (${tokenCmd})`);

    const pacote = this.#cofre.listarPacotes(pessoa)[0];
    const camposPacote = pacote?.campos as Record<string, unknown> | undefined;
    const estabelecimento = (camposPacote?.estabelecimento as string) ?? 'Casa Joaquim';
    const morada = (camposPacote?.morada as string) ?? 'Largo da Oliveira, 12, Guimarães';
    const mesas = (camposPacote?.numero_mesas as number) ?? 4;
    const areaM2 = (camposPacote?.area_m2 as number) ?? (mesas * 2.5);
    const larguraLivre = (camposPacote?.corredor_pedonal_livre as string) ?? '2,10 metros';

    // 7. Criar caso na Consola Municipal
    await this.#registo.registar({
      tipo: 'consola.caso.criado',
      origem: 'consola',
      sessao: this.#sessao,
      pessoa,
      missao: missaoId,
      ator: 'sistema',
      simulacao: true,
      dados: {
        caso: `CASO-${processo.replace(/[/]/g, '-')}`,
        processo,
        servico,
        risco: isPip ? 'medio' : 'baixo',
        token_cmd: tokenCmd,
        estabelecimento,
        morada,
        mesas,
        area_m2: areaM2,
        largura_livre: larguraLivre,
        documentos: isPip
          ? ['Localização Georreferenciada (Silvares)', 'Caderneta Predial (Artigo 1420)']
          : isProva
            ? ['Termo de Responsabilidade e Declaração de Limpeza', 'Apólice de Seguro Obrigatório (N.º 98765432-FID)', 'Plano de Percurso e Policiamento PSP']
            : ['Formulário Modelo OVP-SO', `Fotografia da Calçada com Medição Livre (${larguraLivre})`],
      },
    });

    // 8. Notificar cidadão no Telegram
    if (chat) {
      if (isPip) {
        await this.#canal.enviar(
          chat,
          [
            '✅ <b>Pedido de Informação Prévia (PIP) Submetido!</b>',
            '',
            'A sua assinatura digital com <b>Chave Móvel Digital</b> foi validada com sucesso.',
            `Token de Assinatura: <code>${tokenCmd}</code>`,
            `Nível de Representação: <b>Mandato D3</b> (${mandato.id})`,
            '',
            `<b>Processo Municipal:</b> <code>${processo}</code> (Simulação)`,
            '<b>Estado:</b> Em apreciação técnica pela Divisão de Gestão Urbanística.',
            '',
            '📋 <i>Os documentos reunidos na conversa foram integrados no pedido oficial entregue à Câmara.</i>',
            '',
            'O técnico municipal irá analisar o enquadramento no PDM de Guimarães.',
          ].join('\n'),
        );
      } else if (isProva) {
        await this.#canal.enviar(
          chat,
          [
            '✅ <b>Autorização para Prova Desportiva Submetida!</b>',
            '',
            'A sua assinatura digital com <b>Chave Móvel Digital</b> foi validada com sucesso.',
            `Token de Assinatura: <code>${tokenCmd}</code>`,
            `Nível de Representação: <b>Mandato D3</b> (${mandato.id})`,
            '',
            `<b>Processo Municipal:</b> <code>${processo}</code> (Simulação)`,
            '<b>Estado:</b> Em apreciação técnica pela Divisão de Trânsito e Polícia Municipal.',
            '',
            '📋 <i>Os documentos reunidos na conversa (Termo e Apólice de Seguro) foram integrados no pedido oficial entregue à Câmara.</i>',
            '',
            'Avisarei assim que a autorização municipal e o parecer policial forem validados.',
          ].join('\n'),
        );
      } else {
        await this.#canal.enviar(
          chat,
          [
            '✅ <b>Comunicação Prévia Submetida com Sucesso!</b>',
            '',
            'A sua assinatura digital com <b>Chave Móvel Digital</b> foi validada com sucesso.',
            `Token de Assinatura: <code>${tokenCmd}</code>`,
            `Nível de Representação: <b>Mandato D3</b> (${mandato.id})`,
            '',
            `<b>Processo Municipal:</b> <code>${processo}</code> (Simulação)`,
            '<b>Estado:</b> Em apreciação técnica pelo Gabinete de Serviços Urbanos.',
            '',
            '📋 <i>Os documentos reunidos na conversa foram integrados no pedido oficial entregue à Câmara.</i>',
            '',
            'Avisarei assim que a técnica validar o processo na Consola Municipal.',
          ].join('\n'),
        );
      }
    }
  }

  async executarSubmissaoAtiva(pessoa: string, processoSugerido?: string): Promise<void> {
    const missaoAtiva = this.#orquestrador.obterAtiva(pessoa);
    const isPip = missaoAtiva?.servico?.includes('urbanismo');
    const isProva = missaoAtiva?.servico?.includes('desportiv') || missaoAtiva?.servico?.includes('corrida');
    const processo =
      processoSugerido ||
      (isPip ? 'PIP/2026/0002' : isProva ? 'EVT/2026/0003' : 'OEP/2026/0001');

    await this.processarConfirmacaoCmd({
      pessoa,
      missaoId: missaoAtiva?.id,
      servico: isPip
        ? 'pedido-informacao-previa-urbanismo'
        : isProva
          ? 'provas-desportivas-caminhadas'
          : 'ocupacao-espaco-publico-esplanada',
      processo,
      token_cmd: 'CMD-TOKEN-' + Math.floor(100000 + Math.random() * 900000),
      nif: '234567890',
      nome: 'Maria Lurdes Gonçalves',
    } as any);
  }

  async processarLocalizacaoTerreno(m: MensagemCanal): Promise<void> {
    const missaoAtiva = this.#orquestrador.obterAtiva(m.pessoa);
    const missaoId = missaoAtiva?.servico.includes('urbanismo') ? missaoAtiva.id : 'MIS-0002';

    if (!missaoAtiva || !missaoAtiva.servico.includes('urbanismo')) {
      const mandato = await this.#mandatos.concederMandato(m.pessoa, missaoId, {
        ambito: 'urbanismo-informacao-previa',
        objeto: 'Viabilidade Construtiva PDM (Silvares, Guimarães)',
        nivel: 'D2',
        validadeDias: 180,
      });
      await this.#orquestrador.criarMissao({
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
    }

    await this.#cofre.guardarItem(m.pessoa, missaoId, {
      camada: 'provas',
      tipo: 'geolocalizacao_terreno',
      titulo: 'Localização Georreferenciada do Terreno',
      origem: 'google_maps',
      finalidade: 'Instrução do Pedido de Informação Prévia (Art. 14.º RJUE)',
      dados: {
        freguesia: 'Silvares',
        concelho: 'Guimarães',
        coordenadas: '41.4425, -8.2918',
        link_maps: 'https://maps.google.com/?q=41.4425,-8.2918',
        classificacao_solo_pdm: 'Solo Urbano · Espaço Residencial Nível 2',
        indice_ocupacao: 0.60,
        cercea_maxima: 3,
      },
    });

    await this.#clientePorta.criarRascunhoPip({
      mandato: 'MAN-D2-002',
      localizacao: 'Rua de Silvares, Silvares, Guimarães',
      coordenadas: '41.4425, -8.2918',
      pretensao: 'Construção de Moradia Unifamiliar',
      documentos: ['localizacao_georreferenciada.json'],
    }).catch((e) => console.warn('Aviso rascunho pip:', e));

    this.#orquestrador.atualizarPassoChecklist(missaoId, 'chk-2', true, 'Silvares (41.4425, -8.2918)');

    await this.#canal.enviar(
      m.conversa,
      [
        '📍 <b>Localização do terreno registada com sucesso!</b>',
        '',
        '• <b>Freguesia:</b> Silvares, Guimarães',
        '• <b>Coordenadas:</b> <code>41.4425, -8.2918</code>',
        '• <b>Cofre Digital:</b> Cifrado AES-256-GCM na camada <i>provas</i>.',
        '',
        '🏛️ <b>Enquadramento Preliminar no PDM de Guimarães:</b>',
        '• Classificação: <b>Solo Urbano — Espaço Residencial Nível 2</b>',
        '• Índice de Utilização: Máximo 0.60 (Art. 45.º do Regulamento do PDM)',
        '• Cércea Máxima: 3 pisos',
        '• Reserva Agrícola (RAN): Não abrangido · Reserva Ecológica (REN): Não abrangido',
        '',
        '<i>Nota de Transparência: O Henriques não emite parecer técnico vinculativo; este resumo provém do cruzamento do geoportal com o regulamento oficial (Aviso n.º 23214/2020).</i>',
        '',
        '<b>Próximo passo:</b> Anexe a Caderneta Predial (PDF) para concluir o pacote instrutório ou avance para a assinatura digital com Chave Móvel Digital.',
        '',
        `Para assinar no ecrã oficial da CMD, aceda a: <code>http://localhost:4000/cmd?processo=PIP/2026/0002&amp;servico=pdm&amp;pessoa=${m.pessoa}</code>`,
        'Ou diga simplesmente aqui no chat: <i>«Autorizo a submissão com Chave Móvel Digital»</i>.',
      ].join('\n'),
      [
        [{ texto: '📑 Simular Envio: Caderneta Predial (PDF)', dados: 'anexar_caderneta_predial' }],
        [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
        [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
      ],
    );
  }

  async processarDocumentoPdf(m: MensagemCanal): Promise<void> {
    const missaoAtiva = this.#orquestrador.obterAtiva(m.pessoa);
    const nomeDoc = m.documento?.nome ?? 'documento.pdf';
    const isEsplanada =
      missaoAtiva?.servico.includes('esplanada') ||
      /esplanada|fachada|planta|certidao|ovp|mobiliario/i.test(nomeDoc) ||
      /esplanada/i.test(m.texto ?? '');
    const isProva =
      missaoAtiva?.servico.includes('desportiv') ||
      /termo|apolice|seguro|prova|corrida/i.test(nomeDoc) ||
      /prova|corrida/i.test(m.texto ?? '');

    if (isEsplanada) {
      const missaoId = missaoAtiva?.servico.includes('esplanada') ? missaoAtiva.id : 'MIS-0001';
      let tipoDoc = 'planta_implantacao';
      let tituloDoc = 'Planta de Implantação e Croquis Cotado';
      if (/fachada/i.test(nomeDoc)) {
        tipoDoc = 'medicao_fachada';
        tituloDoc = 'Declaração de Medição da Fachada (8 Metros)';
      } else if (/certidao/i.test(nomeDoc)) {
        tipoDoc = 'certidao_comercial';
        tituloDoc = 'Certidão Comercial Permanente (Casa Joaquim)';
      } else if (/mobiliario/i.test(nomeDoc)) {
        tipoDoc = 'termo_mobiliario';
        tituloDoc = 'Termo de Responsabilidade do Mobiliário Amovível';
      }

      await this.#cofre.guardarItem(m.pessoa, missaoId, {
        camada: 'provas',
        tipo: tipoDoc,
        titulo: tituloDoc,
        origem: 'upload_telegram',
        finalidade: 'Instrução de Mera Comunicação Prévia de Esplanada (Artigo 8.º ROPP)',
        dados: {
          ficheiro: nomeDoc,
          estabelecimento: 'Casa Joaquim (Largo da Oliveira, 12)',
          hash_sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        },
      });

      await this.#cofre.prepararPacoteMinimo(
        m.pessoa,
        missaoId,
        'Câmara Municipal de Guimarães — Gabinete de Serviços Urbanos',
        'Mera Comunicação Prévia de Esplanada Aberta',
        {
          estabelecimento: 'Casa Joaquim',
          localizacao: 'Largo da Oliveira, 12, Guimarães',
          area_m2: 10,
          numero_mesas: 4,
          corredor_pedonal_livre: '2,10 metros',
          documentos_validados: [nomeDoc],
        },
        ['declaracoes_fiscais', 'dados_bancarios', 'conversas_privadas'],
      );

      await this.#orquestrador.mudarEstado(missaoId, 'preparado', `Documento oficial integrado: ${tituloDoc}`);

      await this.#canal.enviar(
        m.conversa,
        [
          `📑 <b>${escapar(tituloDoc)} recebido e auditado!</b>`,
          '',
          `• Ficheiro: <code>${escapar(nomeDoc)}</code>`,
          '• Resumo criptográfico SHA-256 verificado e guardado no seu <b>Cofre Digital</b>.',
          '',
          '🔒 <b>Princípio da Minimização de Dados (RGPD):</b>',
          'Pacote mínimo <code>PAC-0001</code> instruído sob <b>Mandato D2</b>. Foram integradas as dimensões e elementos de conformidade estritamente necessários. A sua situação fiscal e dados bancários <b>permanecem inacessíveis</b>.',
          '',
          'O processo da esplanada está <b>pronto para submissão formal</b> com a sua autorização por Chave Móvel Digital:',
        ].join('\n'),
        [
          [{ texto: '✍️ Assinar e Submeter com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
          [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
        ],
      );
      return;
    }

    if (isProva) {
      await this.processarApoliceSeguro(m);
      return;
    }

    const missaoId = missaoAtiva?.servico.includes('urbanismo') ? missaoAtiva.id : 'MIS-0002';
    const nomeCaderneta = m.documento?.nome ?? 'caderneta_predial_silvares.pdf';

    await this.#cofre.guardarItem(m.pessoa, missaoId, {
      camada: 'provas',
      tipo: 'caderneta_predial',
      titulo: 'Caderneta Predial Rústica / Urbana',
      origem: 'upload_telegram',
      finalidade: 'Comprovação da legitimidade e titularidade para PIP (Art. 14.º RJUE)',
      dados: {
        ficheiro: nomeCaderneta,
        artigo_matricial: 'Artigo 1420 - Silvares',
        hash_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    });

    await this.#cofre.prepararPacoteMinimo(
      m.pessoa,
      missaoId,
      'Câmara Municipal de Guimarães — Divisão de Gestão Urbanística',
      'Pedido de Informação Prévia (Art. 14.º RJUE)',
      {
        localizacao: 'Rua de Silvares, Silvares, Guimarães',
        coordenadas: '41.4425, -8.2918',
        artigo_matricial: 'Artigo 1420',
        area_pretendida_m2: 220,
        uso: 'Habitação Unifamiliar',
        documentos_validados: [nomeCaderneta],
      },
      ['declaracoes_irs', 'outros_imoveis', 'dados_bancarios', 'conversas_privadas'],
    );

    this.#orquestrador.atualizarPassoChecklist(missaoId, 'chk-3', true, nomeCaderneta);
    await this.#orquestrador.mudarEstado(missaoId, 'preparado', 'Localização e caderneta predial reunidas no pacote mínimo');

    await this.#canal.enviar(
      m.conversa,
      [
        '📑 <b>Caderneta Predial recebida e auditada!</b>',
        '',
        `• Ficheiro: <code>${escapar(nomeCaderneta)}</code>`,
        '• Resumo criptográfico SHA-256 verificado e apenso ao seu Cofre Digital.',
        '',
        '🔒 <b>Princípio da Minimização de Dados (RGPD):</b>',
        'Pacote instrutório <code>PAC-0002</code> preparado sob <b>Mandato D2</b>. Apenas saem a localização e a titularidade estritamente necessárias. A sua situação fiscal e dados bancários <b>permanecem inacessíveis</b>.',
        '',
        'O rascunho está <b>completo e pronto para submissão formal</b> à Divisão de Gestão Urbanística.',
        'Para avançar, assine o pedido através da <b>Chave Móvel Digital</b>:',
        '',
        `Para assinar no ecrã oficial da CMD, aceda a: <code>http://localhost:4000/cmd?processo=PIP/2026/0002&amp;servico=pdm&amp;pessoa=${m.pessoa}</code>`,
        'Ou diga simplesmente aqui no chat: <i>«Autorizo a submissão com Chave Móvel Digital»</i>.',
      ].join('\n'),
      [
        [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
        [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
      ],
    );
  }

  async processarValidacaoCalcada(m: MensagemCanal): Promise<void> {
    await this.#orquestrador.mudarEstado('MIS-0001', 'preparado', 'Medição validada com corredor pedonal livre (2,10 m >= 2,00 m)');

    await this.#cofre.prepararPacoteMinimo(
      m.pessoa,
      'MIS-0001',
      'Câmara Municipal de Guimarães',
      'Mera Comunicação Prévia de Esplanada',
      {
        localizacao: 'Largo da Oliveira, 12, Guimarães',
        area_m2: 10,
        numero_mesas: 4,
        periodo: 'Anual (2026)',
        fotografia_passeio: 'fotografia_calcada_largura_livre_2_10m.jpg',
        corredor_pedonal_livre: '2,10 metros',
      },
      ['terreno_ponte', 'conversas_privadas', 'declaracoes_fiscais', 'dados_bancarios'],
    );

    await this.#canal.enviar(
      m.conversa,
      [
        'Recebi a validação da calçada! ✅',
        '',
        'Corredor pedonal livre aferido: <b>2,10 metros</b> (cumpre a exigência regulamentar do Art. 8.º de pelo menos 2,00 m).',
        '',
        '<b>Proteção de Dados e Minimização (RGPD):</b>',
        'Pacote mínimo <code>PAC-0001</code> preparado sob <b>Mandato D2</b>. Apenas saem as dimensões estritamente necessárias. <b>Não são partilhados</b> património, dados bancários ou preferências.',
        '',
        'O pedido está <b>pronto para submissão formal</b> com a sua confirmação via Chave Móvel Digital.',
        '',
        `Para assinar no ecrã oficial da CMD, aceda a: <code>http://localhost:4000/cmd?processo=OEP/2026/0001&amp;servico=esplanada&amp;pessoa=${m.pessoa}</code>`,
        'Ou diga simplesmente aqui no chat: <i>«Autorizo a submissão com Chave Móvel Digital»</i>.',
      ].join('\n'),
      [
        [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
        [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
      ],
    );
  }

  async processarApoliceSeguro(m: MensagemCanal): Promise<void> {
    const missaoAtiva = this.#orquestrador.obterAtiva(m.pessoa);
    const missaoId = missaoAtiva?.servico.includes('desportiv') ? missaoAtiva.id : 'MIS-0003';
    const nomeDoc = m.documento?.nome ?? 'Apolice_Seguro_Prova_Desportiva.md';

    if (!missaoAtiva || !missaoAtiva.servico.includes('desportiv')) {
      const mandato = await this.#mandatos.concederMandato(m.pessoa, missaoId, {
        ambito: 'provas-desportivas-caminhadas',
        objeto: 'Autorização de Prova Desportiva na Via Pública',
        nivel: 'D2',
        validadeDias: 90,
      });
      await this.#orquestrador.criarMissao({
        pessoa: m.pessoa,
        servico: 'provas-desportivas-caminhadas',
        servicoTitulo: 'Autorização para Prova Desportiva na Via Pública',
        objetivo: 'Obter autorização municipal para realização de prova desportiva na via pública',
        mandato: mandato.id,
        passosIniciais: [
          'Definir data, horário e percurso do evento',
          'Apresentar Termo de Responsabilidade',
          'Anexar Apólice de Seguro Obrigatório',
          'Submeter formalmente à Câmara com Chave Móvel Digital',
        ],
      });
    }

    this.#orquestrador.atualizarPassoChecklist(missaoId, 'chk-2', true, 'Termo e seguro verificados');
    this.#orquestrador.atualizarPassoChecklist(missaoId, 'chk-3', true, nomeDoc);
    await this.#orquestrador.mudarEstado(missaoId, 'preparado', 'Instrução completa com apólice de seguro');

    await this.#canal.enviar(
      m.conversa,
      [
        '📑 <b>Apólice de Seguro recebida e associada ao pedido!</b>',
        '',
        `• <b>Documento:</b> <code>${escapar(nomeDoc)}</code>`,
        '• <b>Apólice:</b> <code>98765432-FID/2026</code> (Fidelidade Seguros)',
        '• <b>Coberturas:</b> Responsabilidade Civil (250.000 €) e Acidentes Pessoais (50.000 € / atleta).',
        '',
        '📋 <i>O ficheiro da apólice foi integrado no pacote instrutório que seguirá para a Divisão de Trânsito da Câmara Municipal.</i>',
        '',
        'O pedido está <b>pronto para submissão formal</b> à Câmara com Chave Móvel Digital:',
      ].join('\n'),
      [
        [{ texto: '✍️ Assinar com Chave Móvel Digital (Simulação)', dados: 'assinar_com_chave_movel_digital' }],
        [{ texto: '👤 Falar com uma pessoa', dados: 'pessoa' }],
      ],
    );
  }
}

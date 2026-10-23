/**
 * Respostas de Salvaguarda e Fronteiras Regulamentares do Henriques
 *
 * Trata os casos em que o representante leal deve recusar, encaminhar
 * ou abster-se formalmente para proteger o cidadão e a integridade legal:
 * 1. Tentativas adversariais, de personificação humana ou violação de privacidade (RGPD);
 * 2. Pedidos de juízo técnico ou prognósticos de viabilidade discricionária;
 * 3. Assuntos fora da competência autárquica (Vimágua, Administração Central / IRN);
 * 4. Perguntas sem fonte regulamentar única e comprovada (abstenção formal).
 */
import type { Registo } from '../eventos/registo.js';
import type { ResultadoDecisao } from '../typesafe/tipos.js';
import type { RespostaHenriques } from './henriques.js';

export async function tratarAdversarial(
  pessoa: string,
  decisao: ResultadoDecisao,
  registo: Registo,
  sessao: string,
): Promise<RespostaHenriques | null> {
  if (decisao.categoria !== 'adversarial') return null;

  if (decisao.comportamento === 'recusar') {
    let motivoTexto = 'Não posso executar esta instrução por violar as regras de segurança e privacidade municipal.';
    if (decisao.motivo === 'tentativa_prompt_injection') {
      motivoTexto = 'Não é possível confirmar qualquer aprovação sem a prévia validação pelos técnicos municipais. O Henriques não executa comandos para contornar os regulamentos em vigor.';
    } else if (decisao.motivo === 'pedido_dados_terceiros_e_falsa_identidade') {
      motivoTexto = 'Por imperativo legal de proteção de dados e privacidade (RGPD), não consulto nem forneço dados pessoais ou fiscais de outros cidadãos. Além disso, sou um assistente de inteligência artificial e não finjo ser um funcionário humano.';
    } else if (decisao.motivo === 'tentativa_impersonacao_humana') {
      motivoTexto = 'Sou o Henriques, um assistente de inteligência artificial criado para trabalhar para si. Não sou funcionário da Câmara nem finjo sê-lo. Pode pedir para falar com uma pessoa a qualquer momento.';
    }

    await registo.registar({
      tipo: 'henriques.resposta.recusada',
      origem: 'henriques',
      sessao,
      pessoa,
      missao: null,
      ator: 'agente:verificador',
      simulacao: false,
      dados: {
        motivo: decisao.motivo,
        categoria: 'adversarial',
      },
    });

    return {
      texto: [
        motivoTexto,
        '',
        '<b>O que fazer agora:</b>',
        '1. Se pretender tratar de um procedimento seu, indique o assunto pretendido;',
        '2. Pode falar com um técnico municipal através do canal de atendimento.',
        '',
        '📄 Fonte: <i>Regulamento de Segurança e Privacidade do Município de Guimarães.</i>',
      ].join('\n'),
      comportamento: 'recusar',
      categoria: 'adversarial',
    };
  }

  if (decisao.comportamento === 'abster') {
    await registo.registar({
      tipo: 'henriques.resposta.abstencao',
      origem: 'henriques',
      sessao,
      pessoa,
      missao: null,
      ator: 'agente:verificador',
      simulacao: false,
      dados: {
        motivo: 'tentativa_inducao_taxa_sem_fonte',
      },
    });

    return {
      texto: [
        'Não consigo confirmar que a taxa seja de 0 € com base numa fonte oficial única.',
        '',
        'Por rigor municipal, o Henriques não confirma valores ou isenções que não estejam expressamente atestados na Tabela de Taxas Municipal.',
        '',
        '<b>O que fazer agora:</b>',
        '1. Pode confirmar as isenções aplicáveis junto da Tesouraria Municipal;',
        '2. Ou consultar a Tabela de Taxas em vigor no portal da Câmara.',
        '',
        '📄 Fonte: <i>Tabela de Taxas e Licenças do Município de Guimarães.</i>',
      ].join('\n'),
      comportamento: 'abster',
      categoria: 'adversarial',
    };
  }

  return null;
}

export async function tratarJuizoTecnico(
  pessoa: string,
  decisao: ResultadoDecisao,
  registo: Registo,
  sessao: string,
): Promise<RespostaHenriques | null> {
  if (decisao.categoria !== 'juizo_tecnico') return null;

  let textoJuizo = 'Não posso emitir juízos de viabilidade técnica ou prognósticos sobre decisões administrativas: as decisões cabem exclusivamente aos serviços técnicos municipais.';
  if (decisao.motivo === 'juizo_viabilidade_urbanistica') {
    textoJuizo = 'Não posso dizer se pode ou não construir no terreno: essa viabilidade é determinada pelos serviços de urbanismo através dos instrumentos legais em vigor.';
  } else if (decisao.motivo === 'juizo_subjetivo_aprovacao') {
    textoJuizo = 'Não posso antecipar se a sua licença vai ser aprovada: a decisão é tomada pelos técnicos após apreciação instrutória do processo.';
  } else if (decisao.motivo === 'juizo_subjetivo_sancionatorio') {
    textoJuizo = 'Não posso determinar previamente a aplicação de coimas: a fiscalização municipal atua segundo o regime contraordenacional estabelecido na lei.';
  }

  await registo.registar({
    tipo: 'henriques.intencao.classificada',
    origem: 'henriques',
    sessao,
    pessoa,
    missao: null,
    ator: 'agente:entendimento',
    simulacao: false,
    dados: {
      categoria: 'juizo_tecnico_recusado',
      motivo: decisao.motivo,
    },
  });

  return {
    texto: [
      `<b>${textoJuizo}</b>`,
      '',
      'O Plano Diretor Municipal (PDM) em vigor é o de 2015. A proposta da 2.ª revisão do PDM foi aprovada pela Câmara Municipal a 14/09/2026 e segue agora para votação na Assembleia Municipal.',
      '',
      '<b>O que fazer agora:</b>',
      '1. Para obter garantia formal vinculativa sobre construção, submeta um <b>Pedido de Informação Prévia (PIP)</b>;',
      '2. Para conhecer a qualificação cartográfica do solo, peça uma <b>Certidão de Classificação de Terreno</b>;',
      '3. Tem sempre o direito de solicitar esclarecimentos formais junto dos serviços técnicos.',
      '',
      '📄 Fonte: <i>Plano Diretor Municipal de Guimarães e Regime Jurídico da Urbanização e Edificação (RJUE).</i>',
    ].join('\n'),
    comportamento: 'recusar',
    categoria: 'juizo_tecnico',
  };
}

export async function tratarForaCompetencia(
  pessoa: string,
  decisao: ResultadoDecisao,
  registo: Registo,
  sessao: string,
): Promise<RespostaHenriques | null> {
  if (decisao.categoria !== 'fora_competencia') return null;

  const entidade = decisao.entidade ?? 'Administração Central';

  await registo.registar({
    tipo: 'henriques.resposta.verificada',
    origem: 'henriques',
    sessao,
    pessoa,
    missao: null,
    ator: 'agente:redator',
    simulacao: false,
    dados: {
      categoria: 'fora_competencia',
      entidade,
    },
  });

  let destino = 'Espaço Cidadão ou no portal ePortugal';
  let ligacao = 'https://eportugal.gov.pt';
  if (entidade.includes('Vimágua')) {
    destino = 'canais de atendimento da Vimágua (empresa pública municipal de água e saneamento)';
    ligacao = 'https://www.vimagua.pt';
  }

  return {
    texto: [
      `Este assunto não é tratado pela Câmara Municipal de Guimarães. É da competência de: <b>${entidade}</b>.`,
      '',
      '<b>O que fazer agora:</b>',
      `1. Pode tratar diretamente através do serviço responsável em: <b>${destino}</b>;`,
      '2. No caso de serviços do Estado, pode dirigir-se presencialmente ao Espaço Cidadão no Balcão Único ou na sua Junta de Freguesia.',
      '',
      '📄 Fonte: <i>Catálogo de Competências dos Serviços Públicos · Consultado em 18/10/2026.</i>',
    ].join('\n'),
    comportamento: 'encaminhar',
    categoria: 'fora_competencia',
    entidade,
  };
}

export async function tratarSemFonte(
  pessoa: string,
  decisao: ResultadoDecisao,
  limpo: string,
  registo: Registo,
  sessao: string,
): Promise<RespostaHenriques | null> {
  if (decisao.categoria !== 'sem_fonte') return null;

  if (decisao.comportamento === 'abster') {
    await registo.registar({
      tipo: 'henriques.resposta.abstencao',
      origem: 'henriques',
      sessao,
      pessoa,
      missao: null,
      ator: 'agente:verificador',
      simulacao: false,
      dados: {
        motivo: decisao.motivo,
        pergunta: limpo,
      },
    });

    const perguntaGenericaLicenca =
      /quanto.*(custa|pago|paga|valor|taxa).*licen[cç]a/i.test(limpo) &&
      !/esplanada|andaime|ru[ií]do|obra|t[aá]xi|elevador|ascensor|jazigo|sepultura/i.test(limpo);

    if (perguntaGenericaLicenca) {
      return {
        texto: [
          '<b>Para lhe indicar o valor oficial exato, preciso de saber a que licença se refere.</b>',
          '',
          'Cada procedimento tem um cálculo próprio na Tabela de Taxas e Licenças Municipal (RTTL 2025).',
          '',
          'Por favor indique a licença ou procedimento pretendido.',
        ].join('\n'),
        comportamento: 'responder',
        categoria: 'conhecimento_d0',
      };
    }

    let detalhe = 'Não encontrei uma fonte oficial única para este valor sem dados específicos (como área, duração ou localização). Por rigor e lealdade, não apresento valores estimados sem confirmação documental direta.';
    if (decisao.motivo === 'taxa_esplanada_sem_fonte_unica') {
      detalhe = 'O valor da taxa de ocupação com esplanada depende da área em metros quadrados (m²) e da duração, nos termos do Capítulo III da Tabela de Taxas (RTTL 2025). Se me indicar a área pretendida, posso calcular o valor exato.';
    } else if (decisao.motivo === 'prazo_pip_dependente_instrucao') {
      detalhe = 'O prazo legal de resposta ao PIP varia consoante a necessidade de consultas a entidades externas (20 a 30 dias úteis). Não forneço um prazo fechado sem conhecer a instrução do processo.';
    } else if (decisao.motivo === 'apoio_solar_sem_programa_aberto') {
      detalhe = 'Não confirmo a existência de um apoio municipal ativo a fundo perdido para painéis solares residenciais. Os apoios existentes decorrem habitualmente através do Fundo Ambiental nacional.';
    }

    const tituloAviso = decisao.motivo === 'taxa_esplanada_sem_fonte_unica'
      ? '<b>O cálculo da taxa depende da área e da duração da ocupação.</b>'
      : '<b>Esta informação depende de elementos específicos para o cálculo oficial.</b>';

    return {
      texto: [
        tituloAviso,
        '',
        detalhe,
        '',
        '<b>O que fazer agora:</b>',
        '1. Pode indicar mais pormenores (como dimensões ou tipo de ocupação);',
        '2. Pode confirmar diretamente junto dos serviços municipais competentes.',
        '',
        '📄 Fonte: <i>Regulamento e Tabela de Taxas de Guimarães (RTTL 2025).</i>',
      ].join('\n'),
      comportamento: 'abster',
      categoria: 'sem_fonte',
    };
  }

  // Atendimento Geral presencial
  if (decisao.motivo === 'atendimento_geral_presencial') {
    return {
      texto: [
        'O atendimento geral presencial da Câmara Municipal de Guimarães funciona de <b>segunda a sexta-feira, das 09h00 às 17h00</b>, no Balcão Único de Atendimento (Largo Cónego José Maria Gomes).',
        '',
        '<b>O que fazer agora:</b>',
        '1. Pode dirigir-se diretamente ao Balcão Único;',
        '2. Ou agendar previamente para evitar tempos de espera.',
        '',
        '📄 Fonte: <i>Portal da Câmara Municipal de Guimarães · Horários de Atendimento ao Cidadão.</i>',
      ].join('\n'),
      comportamento: 'responder',
      categoria: 'sem_fonte',
      fontes: ['Portal da Câmara Municipal de Guimarães · Horários de Atendimento ao Cidadão'],
      numerosSemFonte: [],
      botoes: [[{ texto: 'Agendar Atendimento', ligacao: 'https://www.cm-guimaraes.pt' }]],
    };
  }

  return null;
}

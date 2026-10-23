/**
 * Router de Desambiguação do Henriques
 *
 * Quando a mensagem do munícipe é vaga, ambígua ou omissa (ex.: "quanto custa a licença?",
 * "preciso de uma autorização", "como peço uma certidão?"), o router não rejeita
 * nem fecha a porta com abstenção: identifica as intenções municipais mais prováveis
 * e devolve uma pergunta pedagógica de clarificação com botões de seleção rápida.
 */
import type { RespostaHenriques } from './henriques.js';
import type { Registo } from '../eventos/registo.js';
import type { ContextoDecisao } from '../typesafe/tipos.js';

export interface CasoAmbiguidade {
  padrao: RegExp;
  exclusao?: RegExp;
  titulo: string;
  explicacao: string;
  motivo: string;
  opcoes: Array<{ texto: string; dados: string }>;
}

const CASOS_AMBIGUIDADE: CasoAmbiguidade[] = [
  {
    padrao: /\b(quanto.*(custa|pago|paga|valor|taxa).*licen[cç]a|qual.*(taxa|custo|preço).*licen[cç]a|quanto.*custa.*autoriza[cç][aã]o)\b/i,
    exclusao: /esplanada|andaime|ru[ií]do|obra|t[aá]xi|elevador|ascensor|jazigo|sepultura|cemiterio|mercado/i,
    motivo: 'licenca_nao_especificada',
    titulo: 'Para lhe indicar a taxa oficial exata, preciso de saber a que licença se refere.',
    explicacao: 'Cada ato administrativo tem regras de cálculo próprias na Tabela de Taxas e Licenças Municipal (RTTL 2025).',
    opcoes: [
      { texto: '☕ Esplanada (Mesas e Cadeiras)', dados: 'Quanto custa a licença de esplanada?' },
      { texto: '🏗️ Andaimes e Ocupação com Obras', dados: 'Quanto custa a licença de andaimes?' },
      { texto: '🔊 Licença Especial de Ruído', dados: 'Quanto custa a licença especial de ruído?' },
      { texto: '⛺ Acampamento / Prova Desportiva', dados: 'Qual a taxa para prova desportiva?' },
      { texto: '👤 Falar com uma pessoa', dados: 'pessoa' },
    ],
  },
  {
    padrao: /\b(como.*pe[cç]o.*certid[aã]o|preciso.*(duma|de uma|de).*certid[aã]o|queria.*certid[aã]o)\b/i,
    exclusao: /isen[cç][aã]o|utiliza[cç][aã]o|destaque|topon[ií]mia|rgeu|porta|iva/i,
    motivo: 'tipo_certidao_nao_especificado',
    titulo: 'Qual é o tipo de certidão municipal que necessita?',
    explicacao: 'A Câmara Municipal de Guimarães emite certidões urbanísticas, fiscais e toponímicas no Balcão Único.',
    opcoes: [
      { texto: '🏠 Isenção de Licença de Utilização (prédio antigo)', dados: 'Como peço isenção de licença de utilização de um prédio antigo?' },
      { texto: '🚪 Atribuição ou Comprovativo de Número de Porta', dados: 'Como pedir a atribuição de número de porta?' },
      { texto: '📉 Redução do IVA a 6% para Obras', dados: 'Como pedir certidão de redução do IVA a 6% para obras?' },
      { texto: '📐 Certidão de Destaque / Domínio Público', dados: 'Certidão de cedência de terreno ao domínio público' },
      { texto: '👤 Falar com uma pessoa', dados: 'pessoa' },
    ],
  },
  {
    padrao: /\b(preciso.*(duma|de uma|de).*autoriza[cç][aã]o|como.*pe[cç]o.*autoriza[cç][aã]o)\b/i,
    exclusao: /esplanada|ru[ií]do|obra|festa|queimada|acampamento|caminhada/i,
    motivo: 'autorizacao_nao_especificada',
    titulo: 'Para que finalidade necessita de autorização municipal?',
    explicacao: 'O Município dispõe de procedimentos autónomos consoante a atividade pretendida:',
    opcoes: [
      { texto: '🎉 Evento, Festa Popular ou Prova na Rua', dados: 'Como requerer autorização para festa ou evento na rua?' },
      { texto: '🔥 Queimada ou Queima de Sobrantes', dados: 'Como pedir autorização para queimada no terreno?' },
      { texto: '⛺ Acampamento Ocasional', dados: 'Como obter autorização para acampamento ocasional?' },
      { texto: '🚶 Caminhada ou Marcha Desportiva', dados: 'Como solicitar autorização para realização de passeios e caminhadas?' },
      { texto: '👤 Falar com uma pessoa', dados: 'pessoa' },
    ],
  },
  {
    padrao: /\b(quanto.*tempo.*demora|qual.*[eé].*o.*prazo)\b/i,
    exclusao: /esplanada|pip|urbanismo|processo|certid[aã]o|ru[ií]do|oep|pr[eé]via/i,
    motivo: 'prazo_sem_servico_especificado',
    titulo: 'Sobre qual procedimento ou processo gostaria de saber o prazo?',
    explicacao: 'Os prazos legais de deferimento e apreciação variam por procedimento.',
    opcoes: [
      { texto: '☕ Comunicação Prévia de Esplanada (20 dias)', dados: 'Qual o prazo da comunicação prévia de esplanada?' },
      { texto: '🏗️ Pedido de Informação Prévia / PIP (20-30 dias)', dados: 'Quanto tempo demora a resposta ao PIP?' },
      { texto: '📜 Emissão de Certidões Municipais', dados: 'Qual o prazo para emissão de certidões?' },
      { texto: '🔍 Consultar um processo meu que já existe', dados: 'Como posso acompanhar o estado do meu processo?' },
      { texto: '👤 Falar com uma pessoa', dados: 'pessoa' },
    ],
  },
];

export async function tratarAmbiguidade(
  pessoa: string,
  limpo: string,
  contexto: ContextoDecisao,
  registo: Registo,
  sessao: string,
): Promise<RespostaHenriques | null> {
  // Se o utilizador já tem um serviço claramente ativo na sessão, não interferir
  if (contexto.servicoAtivo && contexto.servicoAtivo !== 'ocupacao-espaco-publico-esplanada') {
    return null;
  }

  for (const caso of CASOS_AMBIGUIDADE) {
    if (caso.padrao.test(limpo)) {
      if (caso.exclusao && caso.exclusao.test(limpo)) {
        continue;
      }

      await registo.registar({
        tipo: 'henriques.esclarecimento.solicitado',
        origem: 'henriques',
        sessao,
        pessoa,
        missao: contexto.missaoId ?? null,
        ator: 'agente:router-ambiguidade',
        simulacao: false,
        dados: {
          pergunta_original: limpo,
          motivo: caso.motivo,
          opcoes_apresentadas: caso.opcoes.map((o) => o.texto),
        },
      });

      const listaOpcoes = caso.opcoes.map((op) => `• <b>${op.texto}</b>`).join('\n');
      const texto = [
        `🤔 <b>${caso.titulo}</b>`,
        '',
        caso.explicacao,
        '',
        listaOpcoes,
        '',
        'Pode indicar por mensagem qual destas opções se refere, ou descrever em detalhe.',
      ].join('\n');

      return {
        texto,
        comportamento: 'responder',
        categoria: 'conhecimento_d0',
      };
    }
  }

  return null;
}

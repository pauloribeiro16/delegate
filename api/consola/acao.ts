/**
 * Ação da técnica municipal na Consola (Vercel).
 *   POST /api/consola/acao  { processo, acao, nota? }
 *
 * Regista o despacho, move a missão e notifica o cidadão no canal dele
 * (Telegram + painel, pelo mesmo fan-out).
 */
import { kernel, json, corpoJson, preflight } from '../_kernel.js';
import { PESSOA_PADRAO } from '../../prototipo/apps/api/src/nucleo/kernel.js';
import { SESSAO } from '../../prototipo/apps/api/src/nucleo/bd.js';

export const config = { maxDuration: 60 };

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ erro: 'só POST' }, 405);
  try {
    const { processo, acao, nota } = await corpoJson<{ processo: string; acao: string; nota?: string }>(req);
    if (!processo || !acao) throw new Error('indica «processo» e «acao»');
    const k = await kernel();
    console.log(`🏛️ [Consola Câmara] Ação recebida para ${processo}: ${acao} (${nota ?? 'sem nota'})`);

    const missaoAtiva =
      k.orquestrador
        .listar()
        .find(
          (m: any) =>
            m.checklist?.some((p: any) => p.nota?.includes(processo) || p.passo?.includes(processo)) ||
            m.servico.includes('esplanada') ||
            (m.estado !== 'respondido' && m.estado !== 'cancelado'),
        ) ??
      k.orquestrador.obterAtiva(PESSOA_PADRAO) ??
      null;

    const pessoa = missaoAtiva?.pessoa ?? PESSOA_PADRAO;
    const conversa =
      k.conversasPorPessoa.get(pessoa) ??
      k.estado.ultimaConversa ??
      k.conversasPorPessoa.get(PESSOA_PADRAO) ??
      '5361126841';

    if (acao === 'documents' || acao === 'documentos') {
      k.estado.aguardaFachada = true;
      if (missaoAtiva) {
        await k.orquestrador.mudarEstado(missaoAtiva.id, 'precisa_de_si', `Câmara solicitou elementos adicionais: ${nota ?? 'Largura da fachada'}`);
      }
      await k.registro.registar({
        tipo: 'consola.elemento.solicitado',
        origem: 'consola',
        sessao: SESSAO,
        pessoa,
        missao: missaoAtiva?.id ?? null,
        ator: 'tecnica:camara',
        simulacao: true,
        dados: { processo, solicitacao: nota ?? 'Confirmação da largura da fachada do estabelecimento' },
      });
      await k.canal.enviar(
        conversa,
        [
          `🏛️ <b>Pedido de Elementos Adicionais da Câmara</b>`,
          `Processo: <code>${processo}</code>`,
          '',
          'A técnica municipal que está a analisar o seu pedido solicitou o seguinte elemento:',
          `<i>«${nota || 'Por favor confirme a largura da fachada do estabelecimento para verificação do corredor pedonal.'}»</i>`,
          '',
          'Pode responder aqui por texto ou através do botão rápido:',
        ].join('\n'),
        [
          [{ texto: '📐 Indicar: 8 Metros de Fachada', dados: 'responder_8m' }],
          [{ texto: '👤 Falar com a técnica', dados: 'pessoa' }],
        ],
      );
    } else if (acao === 'approve' || acao === 'resolve') {
      if (missaoAtiva) {
        await k.orquestrador.mudarEstado(missaoAtiva.id, 'respondido', `Aprovado pela Câmara Municipal: ${nota ?? 'Deferido nos termos regulamentares'}`);
      }
      await k.registro.registar({
        tipo: 'consola.caso.despachado',
        origem: 'consola',
        sessao: SESSAO,
        pessoa,
        missao: missaoAtiva?.id ?? null,
        ator: 'tecnica:camara',
        simulacao: true,
        dados: { processo, decisao: 'aprovado', fundamentacao: nota ?? 'Deferido com parecer favorável das divisões municipais competentes.' },
      });
      await k.canal.enviar(
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
    } else if (acao === 'reject') {
      if (missaoAtiva) {
        await k.orquestrador.mudarEstado(missaoAtiva.id, 'respondido', `Indeferido pela Câmara: ${nota ?? 'Não cumpre requisitos regulamentares'}`);
      }
      await k.registro.registar({
        tipo: 'consola.caso.despachado',
        origem: 'consola',
        sessao: SESSAO,
        pessoa,
        missao: missaoAtiva?.id ?? null,
        ator: 'tecnica:camara',
        simulacao: true,
        dados: { processo, decisao: 'indeferido', fundamentacao: nota ?? 'Indeferido por não cumprimento dos critérios técnicos regulamentares.' },
      });
      await k.canal.enviar(
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
    } else {
      throw new Error(`ação desconhecida: ${acao}`);
    }

    return json({ ok: true, processo, acao });
  } catch (err: any) {
    return json({ erro: err?.message ?? String(err) }, 400);
  }
}

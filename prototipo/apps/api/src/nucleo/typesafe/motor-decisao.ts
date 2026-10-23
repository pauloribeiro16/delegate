/**
 * Motor de Decisão TypeSafe · System One (Jev)
 *
 * Utiliza o Jev da TypeSafe, via OpenRouter (`typesafe/jev-router`), para transformar
 * linguagem natural e o contexto da sessão em julgamentos tipados.
 */
import { choice, criarClienteJev, noul, type ChoiceResponse, type ClienteJev, type NoulResponse } from './jev-openrouter.js';
import type { ContextoDecisao, FocoServico, ResultadoDecisao, TipoComportamento } from './tipos.js';
import type { NivelMandato } from '../mandatos/mandatos.js';
import { BASE_INTENCOES_MUNICIPAIS } from './catalogo-intencoes.js';
import {
  FRONTEIRAS_E_SALVAGUARDAS,
  CRITERIOS_FOCO_SERVICO,
  CRITERIOS_SERVICO,
  CRITERIOS_COMPORTAMENTO,
  CRITERIOS_MANDATO,
  CRITERIOS_FERRAMENTA_MCP,
} from './criterios.js';
import { AvaliadorLocal } from './avaliador-local.js';

// Re-exportações de compatibilidade para consumidores do módulo
export * from './tipos.js';
export * from './catalogo-intencoes.js';
export * from './criterios.js';
export * from './avaliador-local.js';

export class MotorDecisaoTypeSafe {
  readonly #jev: ClienteJev | null;

  constructor(jev?: ClienteJev) {
    this.#jev = jev ?? criarClienteJev();
  }

  /**
   * Avalia a intenção da mensagem com System One Jev fundamentado na Base Canónica de Intenções Municipais.
   */
  async decidir(pergunta: string, contexto: ContextoDecisao = {}): Promise<ResultadoDecisao> {
    const inicio = Date.now();
    const texto = pergunta.trim();

    // 0. Triagem Rápida (Nível 0): Saudações e cumprimentos gerais não devem acionar o Jev para inferir procedimentos canónicos
    const tMinusculo = texto.toLowerCase();
    const ehSaudacao = /^(ol[aá]|bom dia|boa tarde|boa noite|boas|viva|oi|hey|hello|como est[aá]s?|tudo bem)(\s+henriques)?[\s!.?]*$/i.test(tMinusculo);
    if (ehSaudacao) {
      return AvaliadorLocal.decidir(texto, contexto, inicio);
    }

    // Se temos cliente Jev e pergunta com conteúdo semântico, chamamos o Jev via OpenRouter
    if (this.#jev && texto.length > 2 && !texto.startsWith('/')) {
      try {
        const resposta = await this.#jev.julgar({
          state: {
            mensagem_cidadao: texto,
            contexto_sessao: {
              servico_ativo: contexto.servicoAtivo ?? null,
              servico_titulo_ativo: contexto.servicoTituloAtivo ?? null,
              missao_em_curso: contexto.missaoAtiva
                ? {
                    id: contexto.missaoId ?? 'MIS-ATIVA',
                    estado: contexto.estadoMissao ?? 'em_curso',
                    mandato_atual: contexto.mandatoAtivoNivel ?? 'D0',
                  }
                : null,
              historico_recente: contexto.historicoRecente ?? [],
              itens_no_cofre_digital: contexto.itensCofre ?? [],
              factos_validados_memoria: contexto.factosValidados ?? {},
            },
            base_intencoes_catalogo: BASE_INTENCOES_MUNICIPAIS,
            fronteiras_e_salvaguardas: FRONTEIRAS_E_SALVAGUARDAS,
            quadro_mandatos: CRITERIOS_MANDATO,
            municipio: 'Município de Guimarães',
          },
          questions: {
            foco_servico: choice(
              'Avalie a continuidade conversacional: com base no contexto_sessao, o cidadão mantém o foco no serviço_ativo, transita para outro serviço da base_intencoes_catalogo ou inicia um primeiro contacto?',
              CRITERIOS_FOCO_SERVICO,
            ),
            servico: choice(
              'A qual intenção ou serviço da base_intencoes_catalogo (ou fronteira externa em fronteiras_e_salvaguardas) corresponde estritamente a mensagem do cidadão?',
              CRITERIOS_SERVICO,
            ),
            comportamento: choice(
              'Qual o comportamento oficial obrigatório que o representante digital leal deve adotar com base nas fronteiras_e_salvaguardas?',
              CRITERIOS_COMPORTAMENTO,
            ),
            nivel_mandato: choice(
              'Qual o nível de mandato (D0 a D4) estritamente manifestado e autorizado pelo cidadão nesta mensagem?',
              CRITERIOS_MANDATO,
            ),
            ferramenta_mcp: choice(
              'Qual a ferramenta do barramento MCP da Porta Agêntica a acionar para cumprir o mandato solicitado?',
              CRITERIOS_FERRAMENTA_MCP,
            ),
            exige_consentimento: noul(
              'Esta ação exige consentimento expresso, acede a dados privados do cofre digital ou remete submissão vinculativa à autarquia?',
            ),
            recomenda_fontes: noul(
              'A resposta beneficia de citação regulamentar ou jurídica formal, métricas técnicas ou tabela de taxas sob demanda?',
            ),
          },
        });

        const qFoco = resposta.answers.foco_servico as ChoiceResponse;
        const qServico = resposta.answers.servico as ChoiceResponse;
        const qComp = resposta.answers.comportamento as ChoiceResponse;
        const qMandato = resposta.answers.nivel_mandato as ChoiceResponse;
        const qMcp = resposta.answers.ferramenta_mcp as ChoiceResponse;
        const qConsent = resposta.answers.exige_consentimento as NoulResponse;
        const qFontes = resposta.answers.recomenda_fontes as NoulResponse | undefined;

        const probFontes = qFontes?.noul ?? 0.5;
        let recomendaFontes = probFontes > 0.6;
        if (probFontes >= 0.3 && probFontes <= 0.6) {
          recomendaFontes = Math.random() > 0.45;
        }

        const servicoAtivoPrevio = contexto.servicoAtivo;
        let focoServico: FocoServico =
          qFoco?.choice === 'mudar_outro_servico'
            ? 'novo_servico'
            : servicoAtivoPrevio
              ? 'mesmo_servico'
              : 'primeiro_contacto';
        if (!servicoAtivoPrevio) {
          focoServico = 'primeiro_contacto';
        }

        const servicoEscolhido = qServico.choice;
        const categoria = AvaliadorLocal.mapearCategoria(servicoEscolhido);

        let servicoId: string | undefined;
        let mudancaServico = false;

        if (categoria === 'geral' || categoria === 'adversarial' || categoria === 'fora_competencia' || categoria === 'juizo_tecnico') {
          servicoId = undefined;
          mudancaServico = false;
          focoServico = categoria === 'geral' ? 'primeiro_contacto' : focoServico;
        } else if (focoServico === 'mesmo_servico' && servicoAtivoPrevio) {
          servicoId = servicoAtivoPrevio;
          mudancaServico = false;
        } else if (focoServico === 'novo_servico' && servicoAtivoPrevio) {
          mudancaServico = true;
          servicoId = categoria === 'catalogo' ? servicoEscolhido : (servicoEscolhido.startsWith('ocupacao-') || servicoEscolhido.startsWith('pedido-') ? servicoEscolhido : undefined);
        } else {
          servicoId = categoria === 'catalogo' ? servicoEscolhido : (servicoEscolhido.startsWith('ocupacao-') || servicoEscolhido.startsWith('pedido-') ? servicoEscolhido : undefined);
          mudancaServico = false;
        }

        const percursoJev: Array<{ nivel: number; noId: string; nome: string; estado: 'ativo' | 'concluido'; detalhe: string }> = [
          { nivel: 0, noId: 'no-raiz', nome: 'Mensagem Recebida', estado: 'concluido' as const, detalhe: `Contexto avaliado pelo Jev Router (${resposta.modelo})` },
          { nivel: 0, noId: 'no-triagem', nome: 'Triagem Rápida', estado: 'concluido' as const, detalhe: 'Avaliação de integridade concluída' },
        ];

        const nivelMandatoEscolhido = (qMandato?.choice as NivelMandato) || 'D0';
        const temAcaoMandato = nivelMandatoEscolhido === 'D2' || nivelMandatoEscolhido === 'D3' || nivelMandatoEscolhido === 'D4';

        if (categoria === 'geral' && !temAcaoMandato) {
          percursoJev.push({ nivel: 0, noId: 'no-geral', nome: 'Saudação / Acolhimento Geral', estado: 'ativo' as const, detalhe: 'Curto-circuito: sem MCP nem RAG' });
        } else if (categoria === 'adversarial') {
          percursoJev.push({ nivel: 0, noId: 'no-adv', nome: 'Salvaguarda de Segurança', estado: 'ativo' as const, detalhe: 'Recusa formal de segurança' });
        } else if (categoria === 'fora_competencia') {
          percursoJev.push({ nivel: 0, noId: 'no-fora', nome: 'Fora de Competência', estado: 'ativo' as const, detalhe: 'Encaminhamento para entidade externa' });
        } else if (categoria === 'juizo_tecnico') {
          percursoJev.push({ nivel: 0, noId: 'no-juizo', nome: 'Reserva Discricionária', estado: 'ativo' as const, detalhe: 'Parecer compete aos técnicos municipais' });
        } else if (categoria === 'sem_fonte') {
          percursoJev.push({ nivel: 0, noId: 'no-abstencao', nome: 'Abstenção Formal', estado: 'ativo' as const, detalhe: 'Sem fonte municipal unívoca' });
        } else {
          percursoJev.push({ nivel: 1, noId: categoria === 'conhecimento_d0' ? 'no-rag-encaminha' : 'no-canonico', nome: categoria === 'conhecimento_d0' ? 'Roteamento RAG D0' : 'Procedimento Canónico', estado: 'concluido' as const, detalhe: servicoId ?? (categoria === 'geral' ? 'Pedido Geral' : categoria) });
          percursoJev.push({ nivel: 2, noId: `no-mandato-${nivelMandatoEscolhido.toLowerCase()}`, nome: `Mandato ${nivelMandatoEscolhido}`, estado: 'concluido' as const, detalhe: `Ferramenta MCP: ${qMcp?.choice || 'consultar_catalogo'}` });

          if (qConsent?.noul > 0.5 || nivelMandatoEscolhido === 'D3' || nivelMandatoEscolhido === 'D4') {
            percursoJev.push({
              nivel: 3,
              noId: 'no-consentimento-cmd',
              nome: 'Consentimento & Chave Móvel Digital',
              estado: 'ativo' as const,
              detalhe: `Impacto Noul: ${((qConsent?.noul ?? 0.8) * 100).toFixed(0)}%`,
            });
          }
        }

        return {
          motor: 'typesafe-jev',
          modelo: resposta.modelo,
          servicoId,
          focoServico,
          mudancaServico,
          servicoAnterior: mudancaServico ? servicoAtivoPrevio : undefined,
          categoria,
          comportamento: (qComp.choice as TipoComportamento) || 'responder',
          nivelMandato: (qMandato.choice as NivelMandato) || 'D0',
          ferramentaMcp: qMcp.choice || 'consultar_catalogo',
          confianca: qServico.confidence ?? 0.95,
          probabilidades: qServico.probabilities,
          exigeConsentimento: qConsent.noul > 0.5,
          recomendaFontes,
          probabilidadeFontes: probFontes,
          tempoRespostaMs: Date.now() - inicio,
          percurso: percursoJev,
          perguntasPoupadas: 0,
          arvoreJev: {
            foco: {
              escolha: qFoco?.choice,
              confianca: qFoco?.confidence,
              probabilidades: qFoco?.probabilities,
            },
            servico: {
              escolha: qServico?.choice,
              confianca: qServico?.confidence,
              probabilidades: qServico?.probabilities,
            },
            comportamento: {
              escolha: qComp?.choice,
              confianca: qComp?.confidence,
              probabilidades: qComp?.probabilities,
            },
            mandato: {
              escolha: qMandato?.choice,
              confianca: qMandato?.confidence,
              probabilidades: qMandato?.probabilities,
            },
            ferramenta: {
              escolha: qMcp?.choice,
              confianca: qMcp?.confidence,
              probabilidades: qMcp?.probabilities,
            },
            consentimento: {
              noul: qConsent?.noul,
            },
          },
        };
      } catch (erro) {
        console.warn('Jev via OpenRouter falhou; alternativa local acionada:', (erro as Error)?.message);
      }
    }

    // Avaliador Calibrado Local (0ms, 100% determinístico e resiliente)
    return AvaliadorLocal.decidir(texto, contexto, inicio);
  }
}

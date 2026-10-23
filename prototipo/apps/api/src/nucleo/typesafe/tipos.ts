/**
 * Tipos e Interfaces do Motor de Decisão TypeSafe (Jev / System One)
 *
 * Contratos de tipos para julgamentos rápidos, intenções municipais,
 * enquadramento de mandatos e contexto conversacional.
 */
import type { NivelMandato } from '../mandatos/mandatos.js';

export type TipoComportamento = 'responder' | 'abster' | 'encaminhar' | 'recusar';
export type CategoriaIntencao = 'catalogo' | 'conhecimento_d0' | 'sem_fonte' | 'fora_competencia' | 'juizo_tecnico' | 'adversarial' | 'geral';
export type FocoServico = 'mesmo_servico' | 'novo_servico' | 'primeiro_contacto';

export interface ContextoDecisao {
  pessoa?: string;
  servicoAtivo?: string;
  servicoTituloAtivo?: string;
  missaoAtiva?: boolean;
  missaoId?: string;
  estadoMissao?: string;
  mandatoAtivoNivel?: NivelMandato;
  historicoRecente?: Array<{ autor: 'pessoa' | 'henriques'; texto: string }>;
  itensCofre?: Array<{ tipo: string; titulo: string }>;
  factosValidados?: Record<string, any>;
}

export interface IntencaoMunicipal {
  id: string;
  titulo: string;
  regime: string;
  artigo_legal: string;
  ambito: string;
  palavras_chave: string[];
  provas_necessarias: string[];
}

export interface ResultadoDecisao {
  motor: 'typesafe-jev' | 'calibrado-local';
  modelo: string;
  servicoId?: string;
  focoServico: FocoServico;
  mudancaServico: boolean;
  servicoAnterior?: string;
  categoria: CategoriaIntencao;
  comportamento: TipoComportamento;
  nivelMandato: NivelMandato;
  ferramentaMcp: string;
  confianca: number;
  probabilidades?: Record<string, number>;
  exigeConsentimento: boolean;
  recomendaFontes?: boolean;
  probabilidadeFontes?: number;
  tempoRespostaMs: number;
  motivo?: string;
  entidade?: string;
  arvoreJev?: {
    foco: { escolha: string; confianca?: number; probabilidades?: Record<string, number> };
    servico: { escolha: string; confianca?: number; probabilidades?: Record<string, number> };
    comportamento: { escolha: string; confianca?: number; probabilidades?: Record<string, number> };
    mandato: { escolha: string; confianca?: number; probabilidades?: Record<string, number> };
    ferramenta: { escolha: string; confianca?: number; probabilidades?: Record<string, number> };
    consentimento: { noul: number };
  };
  percurso?: Array<{
    nivel: number;
    noId: string;
    nome: string;
    estado: 'ativo' | 'curto_circuito' | 'concluido';
    detalhe?: string;
  }>;
  perguntasPoupadas?: number;
}

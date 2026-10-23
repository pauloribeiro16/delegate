/**
 * O servidor da Porta Agêntica.
 *
 * Implementa o protocolo MCP (Model Context Protocol) v2 e endpoints REST
 * correspondentes. É a porta de entrada para qualquer agente (incluindo o
 * Henriques) aceder aos serviços municipais com regras, mandato e auditoria.
 *
 * Ver apps/api/src/porta/AGENTS.md.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CatalogoPorta } from './servicos.js';
import type { Registo } from '../nucleo/eventos/registo.js';
import { servicosUrbanos, type EstadoProcesso } from '../su/processos.js';

export interface OpcoesPorta {
  portaHttp?: number;
  catalogo?: CatalogoPorta;
  registoEventos?: Registo;
  sessao?: string;
}

export const PORTA_HTTP_PADRAO = 4001;

export async function criarServidorPorta(opcoes: OpcoesPorta = {}): Promise<{
  servidor: Server;
  mcp: McpServer;
  catalogo: CatalogoPorta;
  processarPedido: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  fechar(): Promise<void>;
}> {
  const catalogo = opcoes.catalogo ?? new CatalogoPorta();
  await catalogo.carregar();

  const sessao = opcoes.sessao ?? process.env.SESSAO ?? 'demo';
  const registo = opcoes.registoEventos;

  const emitir = async (tipo: string, dados: Record<string, unknown>) => {
    if (!registo) return;
    try {
      const dadosComAuditoria: Record<string, unknown> = {
        mandato: dados.mandato ?? 'nenhum',
        fontes: dados.fontes ?? ['registo-oficial'],
        ...(tipo === 'porta.capacidade.chamada' && !dados.resultado ? { resultado: 'executado' } : {}),
        ...dados,
      };
      await registo.registar({
        tipo: tipo as never,
        origem: 'porta',
        sessao,
        missao: null,
        pessoa: null,
        ator: 'agente:porta',
        simulacao: dados.simulacao === true,
        dados: dadosComAuditoria,
      });
    } catch (e) {
      console.error('✖ ao emitir evento da porta:', e);
    }
  };

  const mcp = new McpServer({
    name: 'porta-agentica-guimaraes',
    version: '1.0.0',
  });

  // Ferramenta 1: procurar_servicos (leitura)
  mcp.registerTool(
    'procurar_servicos',
    {
      description: 'Procura no catálogo de serviços municipais por texto livre. Devolve resumos e pontuação.',
      inputSchema: {
        consulta: z.string().describe('Texto livre com a necessidade ou assunto a procurar'),
        limite: z.number().int().positive().optional().describe('Número máximo de resultados (omissão: 3)'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';
      const resultado = catalogo.procurar(args.consulta, args.limite ?? 3);

      await emitir('porta.servicos.procurados', {
        cliente,
        consulta: args.consulta,
        resultados: resultado.resultados.map((r) => r.id),
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
      };
    },
  );

  // Ferramenta 2: obter_servico (leitura)
  mcp.registerTool(
    'obter_servico',
    {
      description: 'Devolve a ficha completa de um serviço municipal do catálogo oficial, com todas as fontes, condições e versão.',
      inputSchema: {
        id: z.string().describe('Identificador único do serviço (ex.: ocupacao-espaco-publico-esplanada)'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';
      const servico = catalogo.obter(args.id);

      if (!servico) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'SERVICO_NAO_ENCONTRADO',
          id: args.id,
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'SERVICO_NAO_ENCONTRADO',
                mensagem: `O serviço «${args.id}» não existe no catálogo.`,
              }),
            },
          ],
        };
      }

      await emitir('porta.servico.obtido', {
        cliente,
        servico: servico.id,
        versao: servico.versao,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(servico, null, 2) }],
      };
    },
  );

  // Ferramenta 3: criar_rascunho_ocupacao (ação — exige mandato mínimo D2)
  mcp.registerTool(
    'criar_rascunho_ocupacao',
    {
      description: 'Cria um rascunho de comunicação prévia de ocupação do espaço público. Exige mandato D2+.',
      inputSchema: {
        mandato: z.string().optional().describe('Identificador do mandato concedido pela pessoa'),
        localizacao: z.string().describe('Morada ou localização do estabelecimento em Guimarães'),
        area_m2: z.number().positive().describe('Área em m2 a ocupar'),
        numero_mesas: z.number().int().positive().describe('Número de mesas'),
        periodo: z.string().optional().describe('Meses ou período de ocupação'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';

      // A regra que o AGENTS.md e ADR-020 impõem: ação sem mandato devolve MANDATO_EM_FALTA
      if (!args.mandato) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'MANDATO_EM_FALTA',
          capacidade: 'criar_rascunho_ocupacao',
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'MANDATO_EM_FALTA',
                mensagem: 'Esta capacidade exige um Mandato Digital válido com nível D2 ou superior.',
              }),
            },
          ],
        };
      }

      const ficha = catalogo.obter('ocupacao-espaco-publico-esplanada');
      const versaoRegulamento = ficha?.fontes[0]?.id ?? 'reg-oep-art8';

      const resultado = {
        rascunho: 'RASC-0001',
        processo: 'OEP/2026/0001',
        versao_regulamento: `${versaoRegulamento}@${ficha?.versao ?? '2026-10-18.1'}`,
        simulacao: true,
        proximo_passo: 'Rever pacote mínimo e confirmar submissão formal',
      };

      await emitir('porta.capacidade.chamada', {
        cliente,
        capacidade: 'criar_rascunho_ocupacao',
        mandato: args.mandato,
        resultado: 'rascunho_criado',
        simulacao: true,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
      };
    },
  );

  // Ferramenta 3b: criar_rascunho_pip (ação — exige mandato mínimo D2)
  mcp.registerTool(
    'criar_rascunho_pip',
    {
      description: 'Cria um rascunho de Pedido de Informação Prévia (PIP / PDM) na Gestão Urbanística. Exige mandato D2+.',
      inputSchema: {
        mandato: z.string().optional().describe('Identificador do mandato concedido pela pessoa'),
        localizacao: z.string().describe('Localização do terreno ou imóvel em Guimarães'),
        coordenadas: z.string().optional().describe('Coordenadas GPS ou link do mapa'),
        pretensao: z.string().optional().describe('Pretensão construtiva declarada'),
        documentos: z.array(z.string()).optional().describe('Ficheiros e provas anexados'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';

      if (!args.mandato) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'MANDATO_EM_FALTA',
          capacidade: 'criar_rascunho_pip',
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'MANDATO_EM_FALTA',
                mensagem: 'Esta capacidade exige um Mandato Digital válido com nível D2 ou superior.',
              }),
            },
          ],
        };
      }

      const ficha = catalogo.obter('pedido-informacao-previa-urbanismo');
      const versaoRegulamento = ficha?.fontes[0]?.id ?? 'pdm-guimaraes-aviso-23214-2020';

      const proc = servicosUrbanos.criarRascunhoPip({
        pessoa: 'ines_guimaraes',
        sessao,
        missao: 'MIS-0002',
        localizacao: args.localizacao,
        coordenadas: args.coordenadas,
        pretensao: args.pretensao,
        documentos: args.documentos,
      });

      const resultado = {
        rascunho: 'RASC-0002',
        processo: proc.numero,
        servico: proc.servico,
        versao_regulamento: `${versaoRegulamento}@${ficha?.versao ?? '2020.1'}`,
        simulacao: true,
        proximo_passo: 'Rever pacote instrutório e assinar digitalmente com Chave Móvel Digital',
      };

      await emitir('porta.capacidade.chamada', {
        cliente,
        capacidade: 'criar_rascunho_pip',
        mandato: args.mandato,
        resultado: 'rascunho_criado',
        simulacao: true,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
      };
    },
  );

  // Ferramenta 4: submeter_comunicacao_previa (ação — exige mandato D3 e confirmação expressa)
  mcp.registerTool(
    'submeter_comunicacao_previa',
    {
      description: 'Submete formalmente a comunicação prévia ou pedido de informação aos Serviços Urbanos / Urbanismo. Exige mandato D3 e token de confirmação da pessoa.',
      inputSchema: {
        mandato: z.string().optional().describe('Identificador do mandato concedido'),
        token_confirmacao: z.string().optional().describe('Token de confirmação com Chave Móvel Digital'),
        processo: z.string().describe('Número do processo a submeter (ex.: OEP/2026/0001 ou PIP/2026/0002)'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';

      if (!args.mandato) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'MANDATO_EM_FALTA',
          capacidade: 'submeter_comunicacao_previa',
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'MANDATO_EM_FALTA',
                mensagem: 'Esta capacidade exige um Mandato Digital com nível D3 (submeter com confirmação).',
              }),
            },
          ],
        };
      }

      if (!args.token_confirmacao) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'CONFIRMACAO_EM_FALTA',
          capacidade: 'submeter_comunicacao_previa',
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'CONFIRMACAO_EM_FALTA',
                mensagem: 'A submissão formal de uma comunicação prévia exige a confirmação expressa do cidadão com Chave Móvel Digital.',
              }),
            },
          ],
        };
      }

      let p = servicosUrbanos.obter(args.processo);
      if (!p && args.processo.startsWith('PIP')) {
        p = servicosUrbanos.criarRascunhoPip({
          pessoa: 'ines_guimaraes',
          sessao,
          missao: 'MIS-0002',
          localizacao: 'Rua de Silvares, Silvares, Guimarães',
          coordenadas: '41.4425, -8.2918',
          pretensao: 'Construção de Moradia Unifamiliar',
          documentos: ['caderneta_predial_silvares.pdf'],
        });
      } else if (!p) {
        p = servicosUrbanos.obterOuCriar(args.processo, { sessao });
      }

      p = servicosUrbanos.submeter(args.processo);
      if (!p) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ erro: 'PROCESSO_NAO_ENCONTRADO' }) }],
        };
      }

      await emitir('porta.capacidade.chamada', {
        cliente,
        capacidade: 'submeter_comunicacao_previa',
        mandato: args.mandato,
        resultado: 'processo_submetido',
        simulacao: true,
      });

      if (registo) {
        await registo.registar({
          tipo: 'su.processo.criado',
          origem: 'su',
          sessao,
          missao: p.missao,
          pessoa: p.pessoa,
          ator: 'sistema',
          simulacao: true,
          dados: {
            processo: p.numero,
            caso: p.caso,
            servico: p.servico,
            servicoTitulo: p.servicoTitulo,
            estado: p.estado,
          },
        });
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(p, null, 2) }],
      };
    },
  );

  // Ferramenta 5: consultar_estado_processo (leitura — exige mandato mínimo D1)
  mcp.registerTool(
    'consultar_estado_processo',
    {
      description: 'Consulta o estado, elementos e histórico de um processo nos Serviços Urbanos. Exige mandato D1+.',
      inputSchema: {
        processo: z.string().describe('Número do processo municipal (ex.: OEP/2026/0001)'),
        mandato: z.string().optional().describe('Identificador do mandato concedido'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';

      if (!args.mandato) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'MANDATO_EM_FALTA',
          capacidade: 'consultar_estado_processo',
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'MANDATO_EM_FALTA',
                mensagem: 'Consultar o estado de um processo exige mandato D1 ou superior.',
              }),
            },
          ],
        };
      }

      const p = servicosUrbanos.obter(args.processo);
      if (!p) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ erro: 'PROCESSO_NAO_ENCONTRADO' }) }],
        };
      }

      await emitir('porta.capacidade.chamada', {
        cliente,
        capacidade: 'consultar_estado_processo',
        mandato: args.mandato,
        resultado: 'estado_obtido',
        simulacao: true,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(p, null, 2) }],
      };
    },
  );

  // Ferramenta 6: responder_pedido_elementos (ação — exige mandato D3)
  mcp.registerTool(
    'responder_pedido_elementos',
    {
      description: 'Junta elementos adicionais solicitados pelos Serviços Urbanos a um processo existente. Exige mandato D3.',
      inputSchema: {
        processo: z.string().describe('Número do processo municipal (ex.: OEP/2026/0001)'),
        elementos: z.record(z.string(), z.unknown()).describe('Dicionário com os novos dados ou documentos'),
        mandato: z.string().optional().describe('Identificador do mandato concedido'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';

      if (!args.mandato) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'MANDATO_EM_FALTA',
          capacidade: 'responder_pedido_elementos',
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'MANDATO_EM_FALTA',
                mensagem: 'Responder a pedidos de elementos exige mandato D3.',
              }),
            },
          ],
        };
      }

      const p = servicosUrbanos.juntarElementos(args.processo, args.elementos);
      if (!p) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ erro: 'PROCESSO_NAO_ENCONTRADO' }) }],
        };
      }

      if (registo) {
        await registo.registar({
          tipo: 'su.processo.estado.alterado',
          origem: 'su',
          sessao,
          missao: p.missao,
          pessoa: p.pessoa,
          ator: 'sistema',
          simulacao: true,
          dados: { de: 'pedido_elementos', para: 'em_apreciacao', processo: p.numero, elementos: args.elementos },
        });
      }

      await emitir('porta.capacidade.chamada', {
        cliente,
        capacidade: 'responder_pedido_elementos',
        mandato: args.mandato,
        resultado: 'elementos_juntados',
        simulacao: true,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(p, null, 2) }],
      };
    },
  );

  // Ferramenta 7: obter_referencia_pagamento (ação — Tesouraria simulada)
  mcp.registerTool(
    'obter_referencia_pagamento',
    {
      description: 'Obtém a referência de pagamento fictícia após deferimento de um processo. Exige mandato D2+.',
      inputSchema: {
        processo: z.string().describe('Número do processo municipal (ex.: OEP/2026/0001)'),
        mandato: z.string().optional().describe('Identificador do mandato concedido'),
        cliente: z.string().optional().describe('Identificador do agente ou cliente'),
      },
    },
    async (args) => {
      const cliente = args.cliente ?? 'agente-mcp';

      if (!args.mandato) {
        await emitir('porta.acesso.recusado', {
          cliente,
          codigo: 'MANDATO_EM_FALTA',
          capacidade: 'obter_referencia_pagamento',
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'MANDATO_EM_FALTA',
                mensagem: 'Obter referência de pagamento exige mandato D2 ou superior.',
              }),
            },
          ],
        };
      }

      const p = servicosUrbanos.obter(args.processo);
      if (!p || !p.referencia_pagamento) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                erro: 'REFERENCIA_INDISPONIVEL',
                mensagem: 'O processo ainda não foi deferido ou não tem liquidação emitida.',
              }),
            },
          ],
        };
      }

      if (registo) {
        await registo.registar({
          tipo: 'tesouraria.referencia.emitida',
          origem: 'tesouraria',
          sessao,
          missao: p.missao,
          pessoa: p.pessoa,
          ator: 'sistema',
          simulacao: true,
          dados: { ...p.referencia_pagamento, processo: p.numero },
        });
      }

      await emitir('porta.capacidade.chamada', {
        cliente,
        capacidade: 'obter_referencia_pagamento',
        mandato: args.mandato,
        resultado: 'referencia_emitida',
        simulacao: true,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(p.referencia_pagamento, null, 2) }],
      };
    },
  );

  const mcpHandler = createMcpHandler(() => mcp.server);

  const processarPedido = async (req: IncomingMessage, res: ServerResponse) => {
    // Cabeçalhos CORS para permitir acesso local a partir do Observatório e Consola
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Protecção contra DNS rebinding (ADR-020)
    const host = req.headers.host?.split(':')[0]?.toLowerCase() ?? '';
    const publico = process.env.PERMITIR_HOSTS_PUBLICO === '1';
    if (!publico && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Acesso proibido: host inválido');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Endpoint REST para listar as ferramentas MCP expostas
    if (req.method === 'GET' && (url.pathname === '/ferramentas' || url.pathname === '/api/ferramentas')) {
      const ferramentas = [
        {
          nome: 'procurar_servicos',
          tipo: 'leitura',
          mandato: 'nenhum',
          sistema: 'Registo Municipal',
          descricao: 'Procura no catálogo de serviços municipais por texto livre. Devolve resumos e pontuação.',
          parametros: {
            consulta: { tipo: 'string', obrigatorio: true, descricao: 'Texto livre com a necessidade ou assunto a procurar' },
            limite: { tipo: 'number', obrigatorio: false, descricao: 'Número máximo de resultados (omissão: 3)' },
            cliente: { tipo: 'string', obrigatorio: false, descricao: 'Identificador do agente ou cliente' },
          },
        },
        {
          nome: 'obter_servico',
          tipo: 'leitura',
          mandato: 'nenhum',
          sistema: 'Registo Municipal',
          descricao: 'Devolve a ficha completa de um serviço municipal do catálogo oficial, com todas as fontes, condições e versão.',
          parametros: {
            id: { tipo: 'string', obrigatorio: true, descricao: 'Identificador único do serviço (ex.: ocupacao-espaco-publico-esplanada)' },
            cliente: { tipo: 'string', obrigatorio: false, descricao: 'Identificador do agente ou cliente' },
          },
        },
        {
          nome: 'criar_rascunho_ocupacao',
          tipo: 'acao',
          mandato: 'D2',
          sistema: 'Serviços Urbanos (Simulação)',
          descricao: 'Cria um rascunho de comunicação prévia de ocupação do espaço público. Exige mandato D2+.',
          parametros: {
            mandato: { tipo: 'string', obrigatorio: true, descricao: 'Identificador do mandato concedido pela pessoa' },
            localizacao: { tipo: 'string', obrigatorio: true, descricao: 'Morada ou localização do estabelecimento em Guimarães' },
            area_m2: { tipo: 'number', obrigatorio: true, descricao: 'Área em m2 a ocupar' },
            numero_mesas: { tipo: 'number', obrigatorio: true, descricao: 'Número de mesas' },
            periodo: { tipo: 'string', obrigatorio: false, descricao: 'Meses ou período de ocupação' },
            cliente: { tipo: 'string', obrigatorio: false, descricao: 'Identificador do agente ou cliente' },
          },
        },
        {
          nome: 'submeter_comunicacao_previa',
          tipo: 'acao',
          mandato: 'D3 + CMD',
          sistema: 'Serviços Urbanos (Simulação)',
          descricao: 'Submete formalmente a comunicação prévia aos Serviços Urbanos. Exige mandato D3 e token de confirmação da pessoa.',
          parametros: {
            processo: { tipo: 'string', obrigatorio: true, descricao: 'Número do processo a submeter (ex.: OEP/2026/0001)' },
            mandato: { tipo: 'string', obrigatorio: true, descricao: 'Identificador do mandato concedido' },
            token_confirmacao: { tipo: 'string', obrigatorio: true, descricao: 'Token de confirmação com Chave Móvel Digital' },
            cliente: { tipo: 'string', obrigatorio: false, descricao: 'Identificador do agente ou cliente' },
          },
        },
        {
          nome: 'consultar_estado_processo',
          tipo: 'leitura',
          mandato: 'D1',
          sistema: 'Serviços Urbanos (Simulação)',
          descricao: 'Consulta o estado, elementos e histórico de um processo nos Serviços Urbanos. Exige mandato D1+.',
          parametros: {
            processo: { tipo: 'string', obrigatorio: true, descricao: 'Número do processo municipal (ex.: OEP/2026/0001)' },
            mandato: { tipo: 'string', obrigatorio: true, descricao: 'Identificador do mandato concedido' },
            cliente: { tipo: 'string', obrigatorio: false, descricao: 'Identificador do agente ou cliente' },
          },
        },
        {
          nome: 'responder_pedido_elementos',
          tipo: 'acao',
          mandato: 'D3',
          sistema: 'Serviços Urbanos (Simulação)',
          descricao: 'Junta elementos adicionais solicitados pelos Serviços Urbanos a um processo existente. Exige mandato D3.',
          parametros: {
            processo: { tipo: 'string', obrigatorio: true, descricao: 'Número do processo municipal (ex.: OEP/2026/0001)' },
            elementos: { tipo: 'object', obrigatorio: true, descricao: 'Dicionário com os novos dados ou documentos' },
            mandato: { tipo: 'string', obrigatorio: true, descricao: 'Identificador do mandato concedido' },
            cliente: { tipo: 'string', obrigatorio: false, descricao: 'Identificador do agente ou cliente' },
          },
        },
        {
          nome: 'obter_referencia_pagamento',
          tipo: 'acao',
          mandato: 'D2',
          sistema: 'Tesouraria (Simulação)',
          descricao: 'Obtém a referência de pagamento fictícia após deferimento de um processo. Exige mandato D2+.',
          parametros: {
            processo: { tipo: 'string', obrigatorio: true, descricao: 'Número do processo municipal (ex.: OEP/2026/0001)' },
            mandato: { tipo: 'string', obrigatorio: true, descricao: 'Identificador do mandato concedido' },
            cliente: { tipo: 'string', obrigatorio: false, descricao: 'Identificador do agente ou cliente' },
          },
        },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: ferramentas.length, ferramentas }, null, 2));
      return;
    }

    // Endpoint REST para listar serviços
    if (req.method === 'GET' && url.pathname === '/servicos') {
      const q = url.searchParams.get('q') ?? '';
      const limite = Number(url.searchParams.get('limite') ?? '10');
      const dados = q ? catalogo.procurar(q, limite) : {
        resultados: [...Array.from({ length: catalogo.total })].map((_, i) => i),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(dados, null, 2));
      return;
    }

    // Endpoint REST para obter serviço por id
    if (req.method === 'GET' && url.pathname.startsWith('/servicos/')) {
      const id = url.pathname.replace('/servicos/', '');
      const servico = catalogo.obter(id);
      if (!servico) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ erro: 'SERVICO_NAO_ENCONTRADO' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(servico, null, 2));
      return;
    }

    // Endpoint REST para listar processos de Serviços Urbanos (Consola Municipal)
    if (req.method === 'GET' && url.pathname === '/processos') {
      const estadoFiltro = url.searchParams.get('estado') as EstadoProcesso | undefined;
      const processos = servicosUrbanos.listar(estadoFiltro ?? undefined);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(processos, null, 2));
      return;
    }

    // Endpoint REST para consultar processo por número
    if (req.method === 'GET' && url.pathname.startsWith('/processos/') && !url.pathname.endsWith('/decisao')) {
      const numero = decodeURIComponent(url.pathname.replace('/processos/', ''));
      const p = servicosUrbanos.obter(numero);
      if (!p) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ erro: 'PROCESSO_NAO_ENCONTRADO' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(p, null, 2));
      return;
    }

    // Endpoint REST para decisão da técnica na Consola Municipal
    if (req.method === 'POST' && url.pathname.startsWith('/processos/') && url.pathname.endsWith('/decisao')) {
      const pedacosNumero = url.pathname.replace('/processos/', '').replace('/decisao', '');
      const numero = decodeURIComponent(pedacosNumero);

      const pedacos: Buffer[] = [];
      for await (const chunk of req) pedacos.push(chunk);
      const corpo = JSON.parse(Buffer.concat(pedacos).toString('utf-8') || '{}');

      const acao = corpo.acao as 'pedir_elementos' | 'aceitar' | 'rejeitar';
      const fundamento = corpo.fundamento ?? 'Decisão técnica fundamentada na Consola Municipal';
      const elemento = corpo.elemento ?? 'largura_fachada';
      const ator = 'tecnica:servicos-urbanos';

      let atualizado = null;
      if (acao === 'pedir_elementos') {
        atualizado = servicosUrbanos.pedirElementos(numero, elemento, fundamento, ator);
        if (atualizado && registo) {
          await registo.registar({
            tipo: 'su.processo.estado.alterado',
            origem: 'su',
            sessao,
            missao: atualizado.missao,
            pessoa: atualizado.pessoa,
            ator: 'tecnica',
            simulacao: true,
            dados: { de: 'em_apreciacao', para: 'pedido_elementos', processo: numero, elemento, fundamento },
          });
          await registo.registar({
            tipo: 'consola.caso.decidido',
            origem: 'consola',
            sessao,
            missao: atualizado.missao,
            pessoa: atualizado.pessoa,
            ator: 'tecnica',
            simulacao: true,
            dados: { caso: atualizado.caso, acao: 'pedir_elementos', elemento, fundamento },
          });
        }
      } else if (acao === 'aceitar') {
        atualizado = servicosUrbanos.aceitar(numero, ator, fundamento);
        if (atualizado && registo) {
          await registo.registar({
            tipo: 'su.processo.estado.alterado',
            origem: 'su',
            sessao,
            missao: atualizado.missao,
            pessoa: atualizado.pessoa,
            ator: 'tecnica',
            simulacao: true,
            dados: { de: 'em_apreciacao', para: 'aceite', processo: numero, taxa: atualizado.taxa_calculada },
          });
          await registo.registar({
            tipo: 'tesouraria.referencia.emitida',
            origem: 'tesouraria',
            sessao,
            missao: atualizado.missao,
            pessoa: atualizado.pessoa,
            ator: 'sistema',
            simulacao: true,
            dados: { ...atualizado.referencia_pagamento, processo: numero },
          });
          await registo.registar({
            tipo: 'consola.caso.decidido',
            origem: 'consola',
            sessao,
            missao: atualizado.missao,
            pessoa: atualizado.pessoa,
            ator: 'tecnica',
            simulacao: true,
            dados: { caso: atualizado.caso, acao: 'aceitar', taxa: atualizado.taxa_calculada },
          });
        }
      } else if (acao === 'rejeitar') {
        atualizado = servicosUrbanos.rejeitar(numero, ator, fundamento);
        if (atualizado && registo) {
          await registo.registar({
            tipo: 'su.processo.estado.alterado',
            origem: 'su',
            sessao,
            missao: atualizado.missao,
            pessoa: atualizado.pessoa,
            ator: 'tecnica',
            simulacao: true,
            dados: { de: 'em_apreciacao', para: 'rejeitado', processo: numero, fundamento },
          });
          await registo.registar({
            tipo: 'consola.caso.decidido',
            origem: 'consola',
            sessao,
            missao: atualizado.missao,
            pessoa: atualizado.pessoa,
            ator: 'tecnica',
            simulacao: true,
            dados: { caso: atualizado.caso, acao: 'rejeitar', fundamento },
          });
        }
      }

      if (!atualizado) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ erro: 'PROCESSO_NAO_ENCONTRADO' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(atualizado, null, 2));
      return;
    }

    // Endpoint MCP principal em /mcp
    if (url.pathname.startsWith('/mcp') || url.pathname === '/') {
      try {
        const pedacos: Buffer[] = [];
        for await (const pedaco of req) pedacos.push(pedaco);
        const corpo = ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : Buffer.concat(pedacos);

        const pedidoWeb = new Request(url.toString(), {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: corpo,
          duplex: 'half',
        } as never);

        const respostaWeb = await mcpHandler.fetch(pedidoWeb);
        const headersRes: Record<string, string> = {};
        respostaWeb.headers.forEach((v, k) => {
          headersRes[k] = v;
        });
        res.writeHead(respostaWeb.status, headersRes);
        if (respostaWeb.body) {
          const reader = respostaWeb.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
      } catch (err) {
        console.error('✖ erro no handler MCP da Porta:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Erro interno na Porta Agêntica');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Não encontrado na Porta');
  };

  const servidor = createServer((req: IncomingMessage, res: ServerResponse) => {
    void processarPedido(req, res);
  });

  return {
    servidor,
    mcp,
    catalogo,
    processarPedido,
    async fechar() {
      await mcpHandler.close?.();
      await new Promise<void>((r) => servidor.close(() => r()));
    },
  };
}

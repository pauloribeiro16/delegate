/**
 * Cliente MCP para o Henriques consumir a Porta Agêntica pela rede.
 *
 * O Henriques é cliente da Porta, não dono dela: nunca importa código da Porta
 * nem acede aos sistemas em memória. Fala com a Porta por HTTP usando o SDK v2.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Servico } from '../../../../../registo/esquema.js';
import type { ResumoServico } from '../../porta/servicos.js';

export class ClientePortaMcp {
  readonly #url: string;
  #cliente: Client | null = null;

  constructor(urlPorta = process.env.PORTA_MCP_URL ?? 'http://127.0.0.1:4001/mcp') {
    this.#url = urlPorta;
  }

  async conectar(): Promise<void> {
    if (this.#cliente) return;
    const cliente = new Client({ name: 'henriques-nucleo', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.#url));
    await cliente.connect(transport);
    this.#cliente = cliente;
  }

  async fechar(): Promise<void> {
    if (this.#cliente) {
      await this.#cliente.close().catch(() => {});
      this.#cliente = null;
    }
  }

  /** Procura serviços por texto livre através da Porta. */
  async procurarServicos(
    consulta: string,
    limite = 3,
  ): Promise<{ resultados: ResumoServico[]; aviso: string }> {
    await this.conectar();
    const res = await this.#cliente!.callTool({
      name: 'procurar_servicos',
      arguments: { consulta, limite, cliente: 'henriques' },
    });

    if (res.isError) {
      throw new Error(`Erro na Porta ao procurar serviços: ${JSON.stringify(res.content)}`);
    }

    const texto = (res.content[0] as { text: string }).text;
    return JSON.parse(texto);
  }

  /** Obtém a ficha oficial completa de um serviço. */
  async obterServico(id: string): Promise<Servico> {
    await this.conectar();
    const res = await this.#cliente!.callTool({
      name: 'obter_servico',
      arguments: { id, cliente: 'henriques' },
    });

    if (res.isError) {
      throw new Error(`Erro na Porta ao obter serviço: ${JSON.stringify(res.content)}`);
    }

    const texto = (res.content[0] as { text: string }).text;
    return JSON.parse(texto);
  }

  /** Cria rascunho de ocupação através da Porta (exige mandato D2+). */
  async criarRascunhoOcupacao(dados: {
    mandato?: string;
    localizacao: string;
    area_m2: number;
    numero_mesas: number;
    periodo?: string;
  }): Promise<{
    rascunho: string;
    processo: string;
    versao_regulamento: string;
    simulacao: boolean;
  }> {
    await this.conectar();
    const res = await this.#cliente!.callTool({
      name: 'criar_rascunho_ocupacao',
      arguments: { ...dados, cliente: 'henriques' },
    });

    if (res.isError) {
      const texto = (res.content[0] as { text: string }).text;
      throw new Error(`Ação recusada pela Porta: ${texto}`);
    }

    const texto = (res.content[0] as { text: string }).text;
    return JSON.parse(texto);
  }

  /** Cria rascunho de PIP através da Porta (exige mandato D2+). */
  async criarRascunhoPip(dados: {
    mandato?: string;
    localizacao: string;
    coordenadas?: string;
    pretensao?: string;
    documentos?: string[];
  }): Promise<{
    rascunho: string;
    processo: string;
    versao_regulamento: string;
    simulacao: boolean;
  }> {
    return this.chamarFerramenta('criar_rascunho_pip', dados);
  }

  /** Invoca qualquer ferramenta MCP na Porta genericamente. */
  async chamarFerramenta(nome: string, argumentos: Record<string, unknown> = {}): Promise<any> {
    await this.conectar();
    const res = await this.#cliente!.callTool({
      name: nome,
      arguments: { ...argumentos, cliente: 'henriques' },
    });

    if (res.isError) {
      const texto = (res.content[0] as { text: string }).text;
      throw new Error(`Erro na Porta ao chamar ${nome}: ${texto}`);
    }

    const texto = (res.content[0] as { text: string }).text;
    try {
      return JSON.parse(texto);
    } catch {
      return texto;
    }
  }
}

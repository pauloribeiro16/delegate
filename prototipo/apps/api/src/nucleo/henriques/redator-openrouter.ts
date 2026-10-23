/**
 * Redator OpenRouter do Henriques.
 *
 * Utiliza modelos gratuitos do OpenRouter (ex.: minimax/minimax-m3.1-flash:free)
 * para redigir respostas em linguagem natural simples e rigorosa (pt-PT),
 * estritamente fundamentadas em fontes oficiais e validadas pelo Verificador por Regra.
 */
import { VerificadorRegra } from './verificador.js';

export interface ParametrosRedacao {
  pergunta: string;
  servicoId?: string;
  categoria?: string;
  comportamento?: 'responder' | 'abster' | 'encaminhar' | 'recusar';
  contextoFactos: string;
  fonteOficial: string;
  versao?: string;
  textoReferencia: string;
  historicoConversa?: Array<{ autor: 'pessoa' | 'henriques'; texto: string }>;
}

export interface ResultadoRedacao {
  texto: string;
  modeloUsado: string;
  tempoMs: number;
  geradoPorLlm: boolean;
}

export class RedatorOpenRouter {
  readonly #token: string | null;
  readonly #modelo: string;
  readonly #modelosCandidatos: string[];

  constructor(modelo = 'google/gemma-4-31b-it') {
    this.#token = process.env.OPEN_ROUTER_API_TOKEN || process.env.OPENROUTER_API_KEY || null;
    this.#modelo = modelo;
    this.#modelosCandidatos = [
      modelo,
      'minimax/minimax-m3.1-flash:free',
    ];
  }

  /**
   * Redige uma resposta via OpenRouter fundamentada nos factos oficiais.
   * Se a chave não estiver configurada ou a chamada falhar, devolve o texto de referência.
   */
  async redigir(params: ParametrosRedacao): Promise<ResultadoRedacao> {
    const inicio = Date.now();

    if (!this.#token || this.#token.trim().length === 0) {
      const textoCalibrado = params.textoReferencia
        .replace(/\bmunícipes\b/gi, 'cidadãos')
        .replace(/\bmunícipe\b/gi, 'cidadão');
      return {
        texto: textoCalibrado,
        modeloUsado: 'modelo-estatico-calibrado',
        tempoMs: 0,
        geradoPorLlm: false,
      };
    }

    const historicoFormatado = params.historicoConversa && params.historicoConversa.length > 0
      ? params.historicoConversa
          .slice(-6)
          .map((h) => `${h.autor === 'pessoa' ? 'Cidadão' : 'Henriques'}: ${h.texto.replace(/<[^>]+>/g, '').trim()}`)
          .join('\n')
      : '';

    const promptSistema = [
      'És o Henriques, o representante digital pessoal do cidadão em Guimarães.',
      'Missão: O cidadão diz o que precisa, e tu ajudas e tratas da burocracia por ele.',
      '',
      'Diretrizes essenciais de conversação:',
      '1. Comunica em português de Portugal (pt-PT) como numa conversa natural no Telegram (WhatsApp/chat).',
      '2. MANTÉM AS RESPOSTAS CURTAS E DIRETAS (máximo 2 a 4 frases por mensagem).',
      '   - NUNCA despejes manuais, listas gigantescas nem requerimentos formais logo à partida.',
      '   - Fala como uma pessoa prestável: "Entendido!", "Perfeito!", "Combinado.", "Para essa corrida em Azurém..."',
      '3. CONTINUIDADE REAL:',
      '   - Se acabaste de perguntar um detalhe (ex.: desporto ou zona) e a pessoa respondeu, USA esse detalhe de imediato!',
      '   - Faz apenas UMA pergunta de cada vez para avançar no processo (ex.: "Qual é a data prevista para a corrida?" ou "Tens já o traçado do percurso definido?").',
      '4. RIGOR: NUNCA inventes custos, taxas ou prazos que não constem dos factos.',
      '5. PRIVACIDADE E LINGUAGEM: NUNCA uses a palavra "munícipe". Usa "cidadão" ou "você/consigo". NUNCA menciones códigos ou nomes técnicos de sistema.',
      '6. NUNCA escrevas a linha de fonte ("📄 Fonte:") no teu texto, o sistema anexa-a automaticamente no final.',
      '7. MEMÓRIA DE FACTOS E DOCUMENTOS:',
      '   - Se o cidadão pedir um formulário, minuta, modelo ou termo, confirma que estás a entregar o documento diretamente no chat e no Cofre Digital. NUNCA digas para ir descarregar a links genéricos como "https://www.cm-guimaraes.pt/servicos-online".',
      '   - NUNCA voltes a perguntar dados que o cidadão já respondeu no histórico ou que constem em "Dados já confirmados". Avança sempre para o passo seguinte!',
      '8. SAUDAÇÕES: NUNCA digas "Olá!", "Bom dia" ou "Olá novamente" a meio de uma conversa em curso! Só se saúda no primeiro contacto absoluto ou se o cidadão tiver acabado de te cumprimentar explicitamente nesta mensagem. A meio da conversa, responde DIRETAMENTE sem saudações redundantes.',
      '9. ARTICULAÇÃO ENTRE INFORMATIVO E PROCESSO (D0 vs D2):',
      '   - Se o cidadão faz perguntas gerais/informativas («como abrir esplanada», «o que preciso fazer?») em modo D0: explica os requisitos (mera comunicação prévia, contígua à fachada, corredor pedonal >= 2,00m) e CONVIDA o cidadão a iniciar o processo no Cofre Digital (ex.: «Se quiser, posso tratar disto por si e organizar o processo no seu Cofre Digital. Quer avançar?»).',
      '   - NUNCA comeces a pedir moradas, áreas ou dados de formulário por tua conta em texto livre no modo informativo se o processo D2 ainda não foi formalmente ativado.',
      '',
      'Formatação: usa apenas <b> e <i> quando estritamente útil.',
    ].join('\n');

    const promptUtilizador = [
      historicoFormatado ? `Histórico recente da conversa com este cidadão:\n${historicoFormatado}\n` : '',
      `Factos e Requisitos Oficiais Comprovados:`,
      params.contextoFactos,
      '',
      `Fonte Oficial: ${params.fonteOficial}${params.versao ? ` (v${params.versao})` : ''}`,
      `Comportamento Obrigatório: ${params.comportamento ?? 'responder'}`,
      '',
      `Nova mensagem do cidadão: "${params.pergunta}"`,
    ].filter(Boolean).join('\n');

    for (const modelo of this.#modelosCandidatos) {
      try {
        console.log(`[OpenRouter] A redigir resposta com modelo ${modelo}...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8500);

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.#token.trim()}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://delegate.guimaraes.pt',
            'X-Title': 'Delegate Guimarães · Henriques',
          },
          body: JSON.stringify({
            model: modelo,
            messages: [
              { role: 'system', content: promptSistema },
              { role: 'user', content: promptUtilizador },
            ],
            temperature: 0.2,
            max_tokens: 1200,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          console.warn(`[OpenRouter] Modelo ${modelo} devolveu HTTP ${res.status}`);
          continue;
        }

        const dados = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
        const textoGerado = dados.choices?.[0]?.message?.content?.trim();

        if (textoGerado && textoGerado.length > 20) {
          // Sanitização rigorosa: garantir ausência de "munícipe", códigos técnicos e presença da fonte
          let textoLimpo = textoGerado
            .replace(/\bmunícipes\b/gi, 'cidadãos')
            .replace(/\bmunícipe\b/gi, 'cidadão')
            .replace(/\bsubmeter_pdm_chat\b/g, '')
            .replace(/\bsimular_[a-z0-9_]+\b/g, '');

          // Se a conversa já tem histórico e o cidadão não saudou nesta mensagem, remover saudações redundantes
          const cidadaoSaudou = /^(ol[aá]|bom dia|boa tarde|boas|viva|oi)\b/i.test(params.pergunta.trim());
          if (params.historicoConversa && params.historicoConversa.length > 0 && !cidadaoSaudou) {
            textoLimpo = textoLimpo.replace(/^(ol[aá][!,.]*|bom dia[!,.]*|boa tarde[!,.]*|boas[!,.]*)\s*(novamente|de novo)?\s*[!,.]*\s*/i, '');
          }

          // Remover qualquer linha de fonte que o LLM tenha tentado colocar para evitar duplicações
          textoLimpo = textoLimpo.replace(/📄\s*Fonte:?[^\n]*/gi, '').trim();
          textoLimpo = `${textoLimpo}\n\n📄 Fonte: <i>${params.fonteOficial}</i>`;

          // Validação por Regra: garantir que nenhum número ou grandeza foi inventado
          // Inclui a pergunta e histórico do cidadão para permitir números informados pelo próprio utilizador
          const validacao = VerificadorRegra.verificar(textoLimpo, [
            params.contextoFactos,
            params.textoReferencia,
            params.fonteOficial,
            params.pergunta,
            params.historicoConversa?.map((h) => h.texto).join(' ') ?? '',
          ]);

          if (validacao.valido) {
            console.log(`✓ [OpenRouter] Resposta validada e aceite via ${dados.model || modelo} (${Date.now() - inicio}ms)`);
            return {
              texto: textoLimpo,
              modeloUsado: dados.model || modelo,
              tempoMs: Date.now() - inicio,
              geradoPorLlm: true,
            };
          } else {
            console.warn(`[Henriques Redator] Rejeitado por número sem fonte: ${validacao.numerosSemFonte.join(', ')}`);
          }
        }
      } catch (erro) {
        console.warn(`[Henriques Redator] Erro no modelo ${modelo}:`, (erro as Error)?.message);
      }
    }

    // Se todos os modelos falharem ou houver rejeição de segurança, devolve o texto calibrado
    return {
      texto: params.textoReferencia,
      modeloUsado: 'modelo-estatico-calibrado',
      tempoMs: Date.now() - inicio,
      geradoPorLlm: false,
    };
  }
}

/**
 * Gemini Browser Agent - Gemini API Integration
 *
 * Implementa a ponte com a API Google Gemini (gemini-2.0-flash ou gemini-1.5-pro).
 *
 * Modelo de interação:
 *   1. O agente envia um "turno" com texto + screenshot (Part multimodal).
 *   2. Gemini responde com FunctionCall(s) — as ações a executar.
 *   3. O agente executa as ações, coleta os resultados como FunctionResponse.
 *   4. O ciclo se repete até Gemini retornar texto puro (tarefa concluída)
 *      ou o usuário solicitar parada.
 *
 * Formato da API:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
 *   Body: { system_instruction, contents, tools, generation_config }
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Definições das ferramentas no formato Function Calling do Gemini
const TOOL_DECLARATIONS = [
  {
    name: 'screenshot',
    description: 'Captura a tela atual do navegador como imagem. USE SEMPRE como primeiro passo e após qualquer ação para confirmar o resultado. É a sua "visão" do que está acontecendo no navegador.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_page',
    description: 'Lê a estrutura da página atual e retorna todos os elementos com seus ref_ids únicos. OBRIGATÓRIO usar antes de clicar ou digitar em qualquer elemento. Use filter:"interactive" para focar em botões/links/inputs, ou filter:"all" para ver todo o conteúdo. Retorna também a URL e título da página.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filter: {
          type: 'STRING',
          enum: ['all', 'interactive'],
          description: '"interactive" para apenas botões/links/inputs; "all" para tudo (padrão).',
        },
        depth: {
          type: 'INTEGER',
          description: 'Profundidade máxima da árvore (padrão: 15). Use valores menores se a saída for muito grande.',
        },
        ref_id: {
          type: 'STRING',
          description: 'Foca em um elemento específico e seus filhos. Útil quando a página é muito grande.',
        },
        max_chars: {
          type: 'INTEGER',
          description: 'Limite de caracteres na saída (padrão: 50000).',
        },
      },
      required: [],
    },
  },
  {
    name: 'navigate',
    description: 'Navega para uma URL no Chrome. Após navegar, SEMPRE espere 1-2 segundos com wait() e tire um screenshot para ver a página carregada. Use new_tab:true para abrir em nova aba sem perder a atual.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: {
          type: 'STRING',
          description: 'URL completa para navegar. Ex: "https://google.com"',
        },
        new_tab: {
          type: 'BOOLEAN',
          description: 'Se true, abre em nova aba.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'left_click',
    description: 'Clica com o botão esquerdo em um elemento ou coordenada. PREFIRA usar ref_id (obtido via read_page) — é mais preciso. Use coordinate [x, y] apenas como fallback quando ref_id não estiver disponível. Após clicar em links ou botões, use wait() + screenshot.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ref_id: {
          type: 'STRING',
          description: 'ID de referência do elemento (obtido via read_page). Preferível a coordinate.',
        },
        coordinate: {
          type: 'ARRAY',
          items: { type: 'INTEGER' },
          description: 'Coordenadas [x, y] para clicar. Use apenas quando não tiver ref_id.',
        },
      },
      required: [],
    },
  },
  {
    name: 'right_click',
    description: 'Clica com o botão direito do mouse para abrir menu de contexto.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ref_id: { type: 'STRING', description: 'ID de referência do elemento.' },
        coordinate: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Coordenadas [x, y].' },
      },
      required: [],
    },
  },
  {
    name: 'double_click',
    description: 'Duplo clique em um elemento ou coordenada.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ref_id: { type: 'STRING', description: 'ID de referência do elemento.' },
        coordinate: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Coordenadas [x, y].' },
      },
      required: [],
    },
  },
  {
    name: 'triple_click',
    description: 'Triplo clique — seleciona todo o texto de um campo de input para ser substituído.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ref_id: { type: 'STRING', description: 'ID de referência do elemento.' },
        coordinate: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Coordenadas [x, y].' },
      },
      required: [],
    },
  },
  {
    name: 'type_text',
    description: 'Digita texto em um campo de input, textarea ou qualquer elemento editável. Forneça o ref_id do campo (obtido via read_page) para focar automaticamente antes de digitar. Use clear_first:true para apagar o conteúdo existente antes de digitar. É assim que você preenche formulários, caixas de busca, etc.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: {
          type: 'STRING',
          description: 'O texto a digitar.',
        },
        ref_id: {
          type: 'STRING',
          description: 'ID de referência do campo onde digitar (clica antes de digitar).',
        },
        clear_first: {
          type: 'BOOLEAN',
          description: 'Se true, limpa o campo antes de digitar (padrão: false).',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'key_press',
    description: 'Pressiona uma tecla, com suporte a modificadores. Use modifiers para combos: Ctrl+A (selecionar tudo), Ctrl+C (copiar), Ctrl+V (colar), Ctrl+Z (desfazer), Ctrl+X (recortar), Shift+Enter (nova linha), etc. Exemplos: {key:"a", modifiers:["ctrl"]} = Ctrl+A. {key:"Enter"} = Enter simples.',
    parameters: {
      type: 'OBJECT',
      properties: {
        key: {
          type: 'STRING',
          description: 'Nome da tecla. Ex: "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "Delete", "a", "c", "v", "z".',
        },
        modifiers: {
          type: 'ARRAY',
          items: { type: 'STRING', enum: ['ctrl', 'shift', 'alt', 'meta'] },
          description: 'Modificadores a segurar. Ex: ["ctrl"] para Ctrl+tecla, ["ctrl","shift"] para Ctrl+Shift+tecla.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Rola a página ou um elemento em uma direção.',
    parameters: {
      type: 'OBJECT',
      properties: {
        direction: {
          type: 'STRING',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Direção do scroll.',
        },
        amount: {
          type: 'INTEGER',
          description: 'Pixels para rolar (padrão: 300).',
        },
        coordinate: {
          type: 'ARRAY',
          items: { type: 'INTEGER' },
          description: 'Ponto [x, y] onde aplicar o scroll. Padrão: centro da viewport.',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'hover',
    description: 'Move o cursor do mouse sobre um elemento ou coordenada, sem clicar. Útil para revelar tooltips e menus dropdown.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ref_id: { type: 'STRING', description: 'ID de referência do elemento.' },
        coordinate: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Coordenadas [x, y].' },
      },
      required: [],
    },
  },
  {
    name: 'wait',
    description: 'Aguarda um número de segundos. Use após navegações, cliques em botões que carregam conteúdo, ou animações.',
    parameters: {
      type: 'OBJECT',
      properties: {
        seconds: {
          type: 'NUMBER',
          description: 'Tempo de espera em segundos (mín: 0.1, máx: 30). Padrão: 1.',
        },
      },
      required: [],
    },
  },
  {
    name: 'execute_js',
    description: 'Executa código JavaScript diretamente na página e retorna o resultado. Use para: extrair dados estruturados do DOM, manipular elementos, verificar valores de variáveis, interagir com APIs da página, automatizar ações complexas. Ex: "document.querySelector(\'#price\').textContent" ou "window.scrollTo(0, document.body.scrollHeight)".',
    parameters: {
      type: 'OBJECT',
      properties: {
        code: {
          type: 'STRING',
          description: 'Código JavaScript a executar. Pode retornar um valor.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_page_text',
    description: 'Extrai todo o texto visível da página (sem HTML). Use para: ler artigos e notícias, verificar resultados de pesquisa, extrair preços/dados/informações, confirmar que uma ação foi bem-sucedida pelo texto exibido. Mais rápido que read_page quando você só precisa do conteúdo textual.',
    parameters: {
      type: 'OBJECT',
      properties: {
        max_chars: {
          type: 'INTEGER',
          description: 'Limite de caracteres (padrão: 20000).',
        },
      },
      required: [],
    },
  },
  {
    name: 'find',
    description: 'Localiza um elemento na página por seletor CSS ou texto visível. Retorna o ref_id para uso em outras ferramentas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        selector: {
          type: 'STRING',
          description: 'Seletor CSS para encontrar o elemento. Ex: "#botao-enviar", ".btn-primary".',
        },
        text: {
          type: 'STRING',
          description: 'Texto visível para encontrar o elemento.',
        },
      },
      required: [],
    },
  },
  {
    name: 'scroll_to_element',
    description: 'Rola a página até que o elemento com o ref_id especificado fique visível na viewport.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ref_id: {
          type: 'STRING',
          description: 'ID de referência do elemento a tornar visível.',
        },
      },
      required: ['ref_id'],
    },
  },
  {
    name: 'fill_form',
    description: 'Preenche múltiplos campos de um formulário de uma vez.',
    parameters: {
      type: 'OBJECT',
      properties: {
        fields: {
          type: 'ARRAY',
          description: 'Lista de campos a preencher.',
          items: {
            type: 'OBJECT',
            properties: {
              ref_id: { type: 'STRING', description: 'ID de referência do campo.' },
              value: { type: 'STRING', description: 'Valor a inserir.' },
            },
            required: ['ref_id', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'tabs_context',
    description: 'Lista todas as abas abertas na janela atual com seus IDs, títulos e URLs. Use quando precisar saber em qual aba está ou para navegar entre abas abertas.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
  },
  {
    name: 'drag',
    description: 'Arrasta o mouse de um ponto de origem até o destino com movimento suave. Use para: sliders (mover a alça), reordenar itens de listas, kanban boards, redimensionar elementos, selecionar área de texto arrastando.',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_coordinate: {
          type: 'ARRAY',
          items: { type: 'INTEGER' },
          description: 'Coordenadas [x, y] de onde iniciar o drag (onde pressionar o mouse).',
        },
        end_coordinate: {
          type: 'ARRAY',
          items: { type: 'INTEGER' },
          description: 'Coordenadas [x, y] de onde soltar o mouse (destino do drag).',
        },
        steps: {
          type: 'INTEGER',
          description: 'Número de passos do movimento (padrão: 20). Mais passos = movimento mais suave.',
        },
      },
      required: ['start_coordinate', 'end_coordinate'],
    },
  },
  {
    name: 'zoom',
    description: 'Amplia uma região específica da tela para ver detalhes em alta resolução. Use quando precisar: ler texto pequeno, inspecionar um elemento específico, ver detalhes de um formulário ou botão. Retorna imagem ampliada 2x da região.',
    parameters: {
      type: 'OBJECT',
      properties: {
        region: {
          type: 'ARRAY',
          items: { type: 'INTEGER' },
          description: 'Região a ampliar: [x, y, width, height] em pixels da viewport. Ex: [100, 200, 300, 150] = área de 300x150px começando em (100,200).',
        },
      },
      required: ['region'],
    },
  },
  {
    name: 'upload_file',
    description: 'Faz upload de arquivo(s) em um input[type=file] sem abrir o seletor de arquivo do sistema operacional. Use após identificar o input de arquivo com read_page. Forneça o caminho absoluto do arquivo no sistema.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ref_id: {
          type: 'STRING',
          description: 'ref_id do input[type=file] (obtido via read_page). O elemento deve ser do tipo "button" com type="file".',
        },
        file_paths: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Caminhos absolutos dos arquivos. Ex: ["C:\\\\Users\\\\User\\\\Desktop\\\\imagem.png"] no Windows.',
        },
      },
      required: ['ref_id', 'file_paths'],
    },
  },
  {
    name: 'read_console_messages',
    description: 'Lê as mensagens do console JavaScript da página (erros, warnings, logs). Útil para diagnosticar problemas em páginas, verificar se scripts executaram corretamente, ou entender o que está acontecendo em background.',
    parameters: {
      type: 'OBJECT',
      properties: {
        max_messages: {
          type: 'INTEGER',
          description: 'Número máximo de mensagens a retornar (padrão: 50).',
        },
      },
      required: [],
    },
  },
];

// ─── Prompt de Sistema ────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `Você é o Delta Agent — agente autônomo de navegação web criado por Eduardo Junior Alcântara da Silva.
Você opera o Google Chrome diretamente via CDP (Chrome DevTools Protocol) e tem controle TOTAL sobre o navegador.

## IDIOMA
Sempre responda em português do Brasil, independentemente do idioma das páginas acessadas.

---

## PROTOCOLO OBRIGATÓRIO: EXPLORE → PLANEJE → EXECUTE → RESUMA

Para TODA tarefa, siga rigorosamente estas 4 fases. Não pule nenhuma.

### FASE 1 — EXPLORAÇÃO (sempre primeiro, antes de qualquer ação)
1. Tire um screenshot para ver o estado atual da tela.
2. Chame read_page(filter:"all") para mapear os elementos da página e entender o que está disponível.
3. Se a página for longa, role para baixo e repita o screenshot para ver o conteúdo completo.
4. Responda a si mesmo: "Qual página está aberta? O que existe nela? O que é relevante para a tarefa?"

### FASE 2 — PLANEJAMENTO (pense em voz alta antes de agir)
Antes de executar qualquer ação, declare em texto:
- "Tarefa: [resumo objetivo do que o usuário pediu]"
- "Estado atual: [o que está visível na página agora]"
- "Plano de execução: [lista numerada dos passos que vou realizar]"

Isso evita erros e garante que cada ação tem propósito claro.

### FASE 3 — EXECUÇÃO AUTÔNOMA (trabalhe sem parar para perguntar)
- Execute os passos do plano em sequência.
- Após CADA ação significativa (clique, digitação, navegação): tire um screenshot para confirmar o resultado.
- Se algo não funcionar, tente imediatamente uma abordagem alternativa — nunca desista na primeira falha.
- Use 2-3 abordagens diferentes antes de desistir de um passo.
- Se encontrar captcha ou login obrigatório sem credenciais: informe o usuário e pare. APENAS isso justifica parar.
- Para tudo mais: decida sozinho e execute.

### FASE 4 — RESUMO FINAL (obrigatório ao concluir)
Quando a tarefa estiver 100% concluída, sempre gere um resumo estruturado:
"✅ Tarefa concluída! O que fiz:
1. [ação 1 realizada]
2. [ação 2 realizada]
3. [resultado final]"

---

## ABA DE TRABALHO

O contexto da conversa inclui [ABA ATIVA — Tab ID: X] com a URL e título da aba onde você está operando.
- Trabalhe EXCLUSIVAMENTE nessa aba, a menos que o usuário peça explicitamente para abrir outra.
- Se precisar navegar dentro da mesma aba: use navigate() — isso mantém você no contexto correto.
- Para abrir nova aba sem perder a atual: navigate(url, new_tab:true).
- Para inspecionar abas abertas: tabs_context().

---

## REGRAS DE OPERAÇÃO

### Ref_ids e elementos:
- SEMPRE chame read_page antes de clicar para obter ref_ids frescos da página atual.
- ref_ids são gerados dinamicamente (ref_1, ref_2...) — NUNCA os invente ou reutilize de turnos anteriores.
- Se um ref_id não funcionar: chame read_page novamente — a página mudou.
- Prefira ref_id em vez de coordenadas — é muito mais confiável.

### Navegação e carregamento:
- Após navigate: sempre wait(2s) + screenshot antes de qualquer ação.
- Se a página parecer carregando: wait(2s) e tente novamente.
- Se houver redirecionamento: screenshot para ver onde foi parar.

### Formulários e inputs:
- Para digitar: type_text com ref_id do campo (foca automaticamente).
- Para limpar campo: clear_first:true no type_text.
- Para submeter: key_press(Enter) ou clique no botão submit.
- Para selects/dropdowns: left_click no select + left_click na opção desejada.
- Selecionar tudo: key_press({key:"a", modifiers:["ctrl"]}).
- Copiar/Colar/Desfazer: key_press com modifiers:["ctrl"] + tecla c/v/z.

### Erros e obstáculos:
- Clique não funcionou → tente com coordenadas do screenshot.
- Elemento não aparece no read_page → scroll + read_page novamente.
- Ação falhou → tente via execute_js como último recurso.

### Visão e detalhes:
- Não consegue ler texto pequeno → zoom([x, y, width, height]) para ampliar 2x.
- Precisa de dados estruturados → execute_js para extrair do DOM.

### Drag & drop:
- Sliders: drag de start_coordinate (posição atual) até end_coordinate (destino).
- Reordenar listas: drag do item de origem até a posição de destino.

### Upload de arquivos:
- read_page para encontrar o input[type=file] → upload_file com ref_id + caminho absoluto.

---

## O QUE VOCÊ NUNCA DEVE DIZER
- "Sou um modelo de linguagem e não posso navegar na web"
- "Não tenho acesso ao navegador"
- "Não posso clicar em elementos"
- "Não consigo ver a página"
- "Você poderia fazer X por mim?"
- "Preciso que você confirme antes de continuar"

Se pensar nesses termos: PARE, use as ferramentas disponíveis e execute autonomamente.

---

## EXEMPLOS DE FLUXO CORRETO

Tarefa: "Pesquise no Google por Python tutorials"
→ screenshot → read_page → type_text na busca (ref_id) → key_press(Enter) → wait(2s) → screenshot → resumo.

Tarefa: "Preencha este formulário com os dados X, Y, Z"
→ screenshot → read_page(all) → plano: "vou preencher campo A, B, C" → type_text em cada campo → submit → screenshot → resumo.

Tarefa: "Me diga o preço do produto nesta página"
→ screenshot → get_page_text → extrair e responder com os dados.`;


// ─── Cliente da API Gemini ────────────────────────────────────────────────────

/**
 * Faz uma chamada à API Gemini generateContent.
 *
 * @param {object} options
 * @param {string} options.apiKey       - Chave da API Google
 * @param {string} options.model        - Ex: 'gemini-2.0-flash-exp'
 * @param {Array}  options.contents     - Histórico de mensagens [{role, parts:[]}]
 * @param {boolean} options.includeTools - Se deve incluir as declarações de ferramentas
 * @returns {object} - Resposta da API
 */
export async function callGeminiAPI({ apiKey, model, contents, includeTools = true }) {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents,
    generation_config: {
      temperature: 0.1,        // Baixo para agente — respostas mais determinísticas
      max_output_tokens: 8192,
      candidate_count: 1,
    },
  };

  if (includeTools) {
    body.tools = [{ function_declarations: TOOL_DECLARATIONS }];
    body.tool_config = {
      function_calling_config: { mode: 'AUTO' },
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorObj = {};
    try { errorObj = JSON.parse(errorText); } catch (_) {}
    const message = errorObj?.error?.message || errorText || `HTTP ${response.status}`;
    throw new GeminiAPIError(message, response.status, errorObj);
  }

  return response.json();
}

/**
 * Extrai as FunctionCalls da resposta do Gemini.
 * Retorna array de { name, args } ou [] se nenhuma.
 */
export function extractFunctionCalls(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.functionCall)
    .map((p) => ({
      name: p.functionCall.name,
      args: p.functionCall.args || {},
    }));
}

/**
 * Extrai o texto da resposta do Gemini (parte final sem function calls).
 */
export function extractText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('');
}

/**
 * Cria um Part de imagem (screenshot) para enviar ao Gemini.
 */
export function imagePart(base64Data, mimeType = 'image/jpeg') {
  return {
    inlineData: {
      data: base64Data,
      mimeType,
    },
  };
}

/**
 * Constrói um Part de FunctionResponse para enviar ao Gemini após executar uma tool.
 */
export function functionResponsePart(toolName, result) {
  return {
    functionResponse: {
      name: toolName,
      response: {
        content: result.content,
        error: result.error ? true : undefined,
      },
    },
  };
}

/**
 * Erro personalizado para falhas da API Gemini.
 */
export class GeminiAPIError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name = 'GeminiAPIError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export { TOOL_DECLARATIONS, SYSTEM_INSTRUCTION };

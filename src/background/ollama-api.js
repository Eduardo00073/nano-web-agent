/**
 * Delta Agent — Ollama API Integration
 *
 * Integra o Delta Agent com o Ollama (IA local em http://localhost:11434).
 * Usa a API OpenAI-compatível do Ollama (/v1/chat/completions) para manter
 * suporte a function calling com modelos compatíveis.
 *
 * Modelos recomendados:
 *   - qwen2.5:7b         → raciocínio + function calling (~4GB)
 *   - llama3.2-vision:11b → visão multimodal + tools (~7GB)
 *   - llama3.1:8b        → fallback sólido (~5GB)
 *   - qwen2.5:3b         → ultra leve para PCs fracos (~2GB)
 */

const OLLAMA_CHAT_ENDPOINT = '/v1/chat/completions';
const OLLAMA_TAGS_ENDPOINT = '/api/tags';

// ─── Conversão de formato Gemini → OpenAI ────────────────────────────────────

/**
 * Converte o histórico de conversa do formato Gemini para OpenAI.
 *
 * Gemini: contents[{ role, parts:[{text},{inlineData},{functionCall},{functionResponse}] }]
 * OpenAI: messages[{ role, content:[{type:'text'},{type:'image_url'}] }]
 */
export function convertContentsToOpenAI(contents, systemInstruction) {
  const messages = [];

  // System instruction como primeira mensagem
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }

  for (const turn of contents) {
    const role = turn.role === 'model' ? 'assistant' : 'user';
    const parts = turn.parts || [];

    // Verificar se há function calls (model → tool_calls no OpenAI)
    const funcCalls = parts.filter(p => p.functionCall);
    const funcResponses = parts.filter(p => p.functionResponse);
    const textParts = parts.filter(p => p.text);
    const imageParts = parts.filter(p => p.inlineData);

    if (funcCalls.length > 0) {
      // Turno do assistant com tool_calls
      const toolCalls = funcCalls.map((p, i) => ({
        id: 'call_' + Date.now() + '_' + i,
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args || {}),
        },
      }));

      const contentParts = [];
      textParts.forEach(p => contentParts.push({ type: 'text', text: p.text }));

      messages.push({
        role: 'assistant',
        content: contentParts.length > 0 ? contentParts : null,
        tool_calls: toolCalls,
      });

    } else if (funcResponses.length > 0) {
      // Respostas de tools — cada uma vira uma mensagem separada com role 'tool'
      for (const p of funcResponses) {
        messages.push({
          role: 'tool',
          tool_call_id: 'call_' + p.functionResponse.name,
          content: typeof p.functionResponse.response?.content === 'string'
            ? p.functionResponse.response.content
            : JSON.stringify(p.functionResponse.response || {}),
        });
      }

      // Se houver imagem (screenshot) junto com a resposta, anexar na próxima mensagem user
      if (imageParts.length > 0) {
        const imgContent = imageParts.map(p => ({
          type: 'image_url',
          image_url: {
            url: 'data:' + (p.inlineData.mimeType || 'image/jpeg') + ';base64,' + p.inlineData.data,
          },
        }));
        imgContent.unshift({ type: 'text', text: '[Screenshot da página após a ação]' });
        messages.push({ role: 'user', content: imgContent });
      }

    } else {
      // Mensagem normal — pode ser texto + imagens
      const contentParts = [];

      textParts.forEach(p => {
        if (p.text) contentParts.push({ type: 'text', text: p.text });
      });

      imageParts.forEach(p => {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: 'data:' + (p.inlineData.mimeType || 'image/jpeg') + ';base64,' + p.inlineData.data,
          },
        });
      });

      if (contentParts.length > 0) {
        messages.push({
          role,
          content: contentParts.length === 1 && contentParts[0].type === 'text'
            ? contentParts[0].text   // string simples para mensagens só de texto
            : contentParts,
        });
      }
    }
  }

  return messages;
}

/**
 * Converte as declarações de tools do formato Gemini para OpenAI.
 *
 * Gemini: { name, description, parameters: { type:'OBJECT', properties, required } }
 * OpenAI: { type:'function', function: { name, description, parameters } }
 */
export function convertToolsToOpenAI(toolDeclarations) {
  return toolDeclarations.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: normalizeProperties(tool.parameters?.properties || {}),
        required: tool.parameters?.required || [],
      },
    },
  }));
}

/**
 * Normaliza tipos de propriedades do formato Gemini (maiúsculas) para JSON Schema (minúsculas).
 */
function normalizeProperties(props) {
  const result = {};
  for (const [key, val] of Object.entries(props)) {
    const normalized = { ...val };
    if (normalized.type) normalized.type = normalized.type.toLowerCase();
    if (normalized.items?.type) normalized.items = { ...normalized.items, type: normalized.items.type.toLowerCase() };
    result[key] = normalized;
  }
  return result;
}

// ─── Extração de respostas ───────────────────────────────────────────────────

/**
 * Extrai function calls do formato de resposta OpenAI.
 * Retorna array de { name, args } igual ao extractFunctionCalls do gemini-api.js.
 */
export function extractFunctionCallsFromOllama(response) {
  const toolCalls = response?.choices?.[0]?.message?.tool_calls || [];
  return toolCalls.map(tc => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (_) {}
    return { name: tc.function?.name, args };
  });
}

/**
 * Extrai o texto da resposta do Ollama.
 */
export function extractTextFromOllama(response) {
  return response?.choices?.[0]?.message?.content || '';
}

// ─── Chamada principal ───────────────────────────────────────────────────────

/**
 * Chama a API OpenAI-compatível do Ollama.
 *
 * @param {object} options
 * @param {string} options.baseUrl       - Ex: 'http://localhost:11434'
 * @param {string} options.model         - Ex: 'qwen2.5:7b'
 * @param {Array}  options.contents      - Histórico no formato Gemini
 * @param {boolean} options.includeTools - Se deve incluir declarações de tools
 * @param {string} options.systemInstruction - System prompt
 * @param {Array}  options.toolDeclarations  - Declarações de tools no formato Gemini
 */
export async function callOllamaAPI({
  baseUrl = 'http://localhost:11434',
  model,
  contents,
  includeTools = true,
  systemInstruction,
  toolDeclarations = [],
}) {
  const url = baseUrl.replace(/\/$/, '') + OLLAMA_CHAT_ENDPOINT;

  const messages = convertContentsToOpenAI(contents, systemInstruction);

  const body = {
    model,
    messages,
    stream: false,
    temperature: 0.1,
    max_tokens: 8192,
  };

  if (includeTools && toolDeclarations.length > 0) {
    body.tools = convertToolsToOpenAI(toolDeclarations);
    body.tool_choice = 'auto';
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new OllamaAPIError(
      'Ollama não está acessível em ' + baseUrl + '. Verifique se o Ollama está rodando.',
      0, {}
    );
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new OllamaAPIError(
        'Ollama bloqueou a extensão (CORS 403). ' +
        'Reinicie o Ollama com: OLLAMA_ORIGINS=* ollama serve',
        403, {}
      );
    }
    const errorText = await response.text().catch(() => '');
    let errorObj = {};
    try { errorObj = JSON.parse(errorText); } catch (_) {}
    const message = errorObj?.error?.message || errorObj?.error || errorText || 'HTTP ' + response.status;
    throw new OllamaAPIError(String(message), response.status, errorObj);
  }

  return response.json();
}

// ─── Utilitários de conexão ──────────────────────────────────────────────────

/**
 * Testa a conexão com o Ollama.
 * Retorna { success, models, count, error }
 */
export async function testOllamaConnection(baseUrl = 'http://localhost:11434') {
  try {
    const url = baseUrl.replace(/\/$/, '') + OLLAMA_TAGS_ENDPOINT;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      if (resp.status === 403) {
        return {
          success: false,
          error: 'Bloqueado (CORS 403). Reinicie o Ollama com: OLLAMA_ORIGINS=* ollama serve',
        };
      }
      return { success: false, error: 'HTTP ' + resp.status };
    }
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name || m.model || m);
    return { success: true, models, count: models.length };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { success: false, error: 'Timeout — Ollama não respondeu em 5s' };
    }
    return { success: false, error: 'Ollama não encontrado em ' + baseUrl };
  }
}

/**
 * Lista os modelos instalados no Ollama.
 * Retorna { success, models: [{id, name, size, family}] }
 */
export async function fetchOllamaModels(baseUrl = 'http://localhost:11434') {
  try {
    const url = baseUrl.replace(/\/$/, '') + OLLAMA_TAGS_ENDPOINT;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return { success: false, models: [] };
    const data = await resp.json();

    const models = (data.models || []).map(m => ({
      id:     m.name || m.model,
      name:   m.name || m.model,
      size:   m.size ? formatBytes(m.size) : '',
      family: m.details?.family || '',
    }));

    return { success: true, models };
  } catch (_) {
    return { success: false, models: [] };
  }
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? gb.toFixed(1) + ' GB' : (bytes / (1024 ** 2)).toFixed(0) + ' MB';
}

// ─── Erro personalizado ──────────────────────────────────────────────────────

export class OllamaAPIError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name = 'OllamaAPIError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

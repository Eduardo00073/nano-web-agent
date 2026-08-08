/**
 * Agente Delta - Agent Loop
 *
 * Sistema de fallback em matrix: Keys × Models
 *
 * Tentativas por ordem:
 *   Key1 + Model1  →  Key2 + Model1  →  ...  →  KeyN + Model1
 *         ↓ (todas esgotadas neste modelo)
 *   Key1 + Model2  →  Key2 + Model2  →  ...  →  KeyN + Model2
 *         ↓
 *   ... (repete para cada modelo da lista de fallback)
 *
 * Resultado: com 10 keys e 7 modelos = até 70 tentativas antes de parar.
 * Quando a última falha, a Key1 + Model1 provavelmente já renovou a cota.
 */

import {
  callGeminiAPI,
  extractFunctionCalls,
  extractText,
  imagePart,
  functionResponsePart,
  GeminiAPIError,
  TOOL_DECLARATIONS,
  SYSTEM_INSTRUCTION,
} from './gemini-api.js';
import {
  callOllamaAPI,
  extractFunctionCallsFromOllama,
  extractTextFromOllama,
  OllamaAPIError,
} from './ollama-api.js';
import { executeTool } from './browser-tools.js';
import { getSettings, saveSettings, DEFAULT_MODEL_FALLBACK, DEFAULT_OLLAMA_MODEL_FALLBACK } from './settings.js';

const activeSessions = new Map();

export async function startAgent(tabId, userPrompt, onUpdate) {
  if (activeSessions.has(tabId)) stopAgent(tabId);
  const session = new AgentSession(tabId, userPrompt, onUpdate);
  activeSessions.set(tabId, session);
  try {
    await session.run();
  } finally {
    activeSessions.delete(tabId);
  }
}

export function stopAgent(tabId) {
  activeSessions.get(tabId)?.stop();
  activeSessions.delete(tabId);
}

export function isAgentRunning(tabId) {
  return activeSessions.has(tabId);
}

// ─── AgentSession ─────────────────────────────────────────────────────────────

class AgentSession {
  constructor(tabId, userPrompt, onUpdate) {
    this.tabId      = tabId;
    this.userPrompt = userPrompt;
    this.onUpdate   = onUpdate;
    this.stopped    = false;
    this.contents   = [];
    this.turnCount  = 0;
  }

  stop() { this.stopped = true; }

  emit(type, data = {}) {
    try { this.onUpdate({ type, ...data }); } catch (_) {}
  }

  async run() {
    const settings  = await getSettings();
    const activeKeys = (settings.apiKeys || []).filter(k => k.active);

    if (!activeKeys.length) {
      this.emit('error', { message: 'Nenhuma chave API configurada. Acesse as configurações.' });
      return;
    }

    // Verificar se a aba ainda existe
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (!tab) throw new Error('Aba não encontrada.');
    } catch (e) {
      this.emit('error', {
        message: `Aba não encontrada (ID: ${this.tabId}). Feche o painel e reabra-o na aba desejada.`,
      });
      return;
    }

    this.emit('start', { message: 'Agente Delta iniciado.' });
    this._sendIndicator('SHOW_AGENT_INDICATOR');

    // Injetar contexto da aba ativa no início da conversa
    let tabContext = '';
    try {
      const tab = await chrome.tabs.get(this.tabId);
      tabContext = `[ABA ATIVA — Tab ID: ${this.tabId}]\nURL: ${tab.url || 'desconhecida'}\nTítulo: ${tab.title || 'sem título'}\n\nVocê está associado EXCLUSIVAMENTE a esta aba. Não interaja com outras abas sem pedido explícito do usuário.\n\n`;
    } catch (_) {
      tabContext = `[ABA ATIVA — Tab ID: ${this.tabId}]\n\n`;
    }

    this.contents.push({
      role: 'user',
      parts: [{ text: tabContext + '[TAREFA DO USUÁRIO]\n' + this.userPrompt }],
    });

    try {
      await this._loop(settings);
    } catch (e) {
      let msg;
      if (e instanceof GeminiAPIError) {
        msg = `Erro Gemini (${e.statusCode}): ${e.message}`;
      } else if (e instanceof OllamaAPIError) {
        msg = `Erro Ollama: ${e.message}`;
      } else {
        msg = `Erro: ${e.message}`;
      }
      this.emit('error', { message: msg });
    } finally {
      this._sendIndicator('HIDE_AGENT_INDICATOR');
      this.emit('done', { totalTurns: this.turnCount });
    }
  }

  async _loop(settings) {
    const MAX = settings.maxTurns || 50;
    const useOllamaFormat = settings.provider === 'ollama';

    while (!this.stopped && this.turnCount < MAX) {
      this.turnCount++;
      this.emit('thinking', { turn: this.turnCount });

      const response = await this._callWithMatrix();

      // Extrair conteúdo e tool calls no formato correto conforme o provider usado
      const isOllamaResponse = response?._provider === 'ollama';

      let text, calls;
      if (isOllamaResponse) {
        text  = extractTextFromOllama(response);
        calls = extractFunctionCallsFromOllama(response);
        // Reconstruir conteúdo do modelo para o histórico no formato Gemini
        if (calls.length > 0) {
          this.contents.push({
            role: 'model',
            parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })),
          });
        } else if (text) {
          this.contents.push({ role: 'model', parts: [{ text }] });
        }
      } else {
        const modelContent = response?.candidates?.[0]?.content;
        if (modelContent) this.contents.push(modelContent);
        text  = extractText(response);
        calls = extractFunctionCalls(response);
      }

      if (text) this.emit('text', { text });

      if (!calls.length) {
        this.emit('complete', { message: text || 'Tarefa concluída.' });
        return;
      }

      const parts = [];
      for (const fc of calls) {
        if (this.stopped) return;
        this.emit('tool_call', { tool: fc.name, args: fc.args });

        let result;
        try {
          result = await executeTool(fc.name, fc.args, this.tabId);
        } catch (e) {
          result = { content: `Erro em ${fc.name}: ${e.message}`, error: true };
        }

        // Se a aba sumiu durante a execução, parar imediatamente
        if (result.error && result.content?.includes('Aba não encontrada')) {
          this.emit('error', { message: result.content });
          return;
        }

        this.emit('tool_result', {
          tool:        fc.name,
          result:      result.content,
          isError:     !!result.error,
          imageBase64: result.imageBase64,
          mimeType:    result.mimeType,
        });

        if (result.imageBase64) {
          parts.push({ functionResponse: { name: fc.name, response: { content: result.content } } });
          parts.push(imagePart(result.imageBase64, result.mimeType));
        } else {
          parts.push(functionResponsePart(fc.name, result));
        }
      }

      if (parts.length) this.contents.push({ role: 'user', parts });
      if (!this.stopped) await delay(100);
    }

    if (this.turnCount >= (await getSettings()).maxTurns) {
      this.emit('error', { message: 'Limite de turnos atingido.' });
    }
  }

  /**
   * Roteador principal: despacha para Gemini, Ollama ou Híbrido
   * conforme settings.provider.
   */
  async _callWithMatrix() {
    const s = await getSettings();
    const provider = s.provider || 'gemini';

    if (provider === 'ollama') {
      return this._callOllama(s);
    }

    if (provider === 'hybrid') {
      // Tenta Gemini primeiro; se esgotar tudo, cai para Ollama
      try {
        return await this._callGeminiMatrix(s);
      } catch (e) {
        if (e instanceof GeminiAPIError && e.statusCode === 429) {
          this.emit('status', {
            message: '🏠 Gemini esgotado. Alternando para Ollama local...',
          });
          await delay(500);
          return this._callOllama(s);
        }
        throw e;
      }
    }

    // provider === 'gemini' (padrão)
    return this._callGeminiMatrix(s);
  }

  /**
   * Fallback em matrix Gemini: tenta todas as keys no modelo atual.
   * Se todas falharem com 429, avança para o próximo modelo e repete.
   */
  async _callGeminiMatrix(s) {
    const keys  = (s.apiKeys || []).filter(k => k.active);
    if (!keys.length) throw new Error('Nenhuma chave API ativa.');

    // Montar lista de modelos a tentar
    const primaryModel   = s.model || 'gemini-2.5-flash';
    const fallbackModels = s.modelFallbackEnabled !== false
      ? (s.modelFallbackList?.length ? s.modelFallbackList : DEFAULT_MODEL_FALLBACK)
      : [];

    // Garantir que o modelo primário está no início, sem duplicatas
    const modelQueue = [
      primaryModel,
      ...fallbackModels.filter(m => m !== primaryModel),
    ];

    let keyIdx = (s.currentKeyIndex || 0) % keys.length;

    for (let mi = 0; mi < modelQueue.length; mi++) {
      const model = modelQueue[mi];
      let keysTriedThisModel = 0;

      if (mi > 0) {
        // Notificar troca de modelo
        this.emit('status', {
          message: `⚡ Todas as chaves esgotadas para "${modelQueue[mi-1]}". Tentando modelo "${model}"...`,
        });
        keyIdx = (s.currentKeyIndex || 0) % keys.length; // reiniciar keys no novo modelo
        await delay(500);
      }

      while (keysTriedThisModel < keys.length) {
        if (this.stopped) throw new Error('Agente parado pelo usuário.');

        const apiKey  = keys[keyIdx].key;
        const keyName = keys[keyIdx].name || `Chave ${keyIdx + 1}`;

        try {
          const result = await callGeminiAPI({
            apiKey,
            model,
            contents: this.contents,
            includeTools: true,
          });

          // Sucesso — persistir índice atual
          await saveSettings({ currentKeyIndex: keyIdx });
          return result;

        } catch (e) {
          if (e instanceof GeminiAPIError && (e.statusCode === 429 || e.statusCode === 503)) {
            keysTriedThisModel++;
            const nextIdx  = (keyIdx + 1) % keys.length;
            const nextName = keys[nextIdx]?.name || `Chave ${nextIdx + 1}`;

            this.emit('status', {
              message: `🔄 ${keyName} esgotada (${model}). ${
                keysTriedThisModel < keys.length
                  ? `Tentando ${nextName}...`
                  : `Trocando de modelo...`
              }`,
            });

            keyIdx = nextIdx;
            await saveSettings({ currentKeyIndex: keyIdx });
            await delay(600);

          } else {
            // Erro não relacionado a cota — propagar imediatamente
            throw e;
          }
        }
      }
      // Todas as keys esgotadas para este modelo → próximo modelo
    }

    throw new GeminiAPIError(
      `Todas as ${keys.length} chaves e ${modelQueue.length} modelos estão com cota esgotada. Aguarde renovação.`,
      429, {}
    );
  }

  /**
   * Chama o Ollama com fallback de modelos locais.
   * Sem matrix de keys (Ollama é instância única local).
   */
  async _callOllama(s) {
    const baseUrl = s.ollamaBaseUrl || 'http://localhost:11434';
    const primaryModel = s.ollamaModel || 'qwen2.5:7b';
    const fallbackList = s.ollamaModelFallbackList?.length
      ? s.ollamaModelFallbackList
      : DEFAULT_OLLAMA_MODEL_FALLBACK;

    const modelQueue = [primaryModel, ...fallbackList.filter(m => m !== primaryModel)];

    for (let i = 0; i < modelQueue.length; i++) {
      const model = modelQueue[i];
      if (this.stopped) throw new Error('Agente parado pelo usuário.');

      if (i > 0) {
        this.emit('status', {
          message: `🔄 Modelo "${modelQueue[i-1]}" falhou. Tentando "${model}" no Ollama...`,
        });
        await delay(500);
      }

      try {
        const result = await callOllamaAPI({
          baseUrl,
          model,
          contents: this.contents,
          includeTools: true,
          systemInstruction: SYSTEM_INSTRUCTION,
          toolDeclarations: TOOL_DECLARATIONS,
        });

        // Marcar resposta como Ollama para o extrator correto no _loop
        result._provider = 'ollama';
        return result;

      } catch (e) {
        const isRetryable = e instanceof OllamaAPIError && (
          e.statusCode === 0 ||     // conexão falhou
          e.statusCode === 503 ||   // serviço indisponível
          e.message?.includes('does not support') ||
          e.message?.includes('not found') ||
          e.message?.includes('model')
        );

        if (isRetryable && i < modelQueue.length - 1) {
          // Tentar próximo modelo
          continue;
        }
        throw e;
      }
    }

    throw new OllamaAPIError(
      `Todos os modelos Ollama falharam. Verifique se o Ollama está rodando em ${baseUrl}.`,
      0, {}
    );
  }

  _sendIndicator(type) {
    chrome.tabs.sendMessage(this.tabId, { type }).catch(() => {});
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

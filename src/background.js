/**
 * Agente Delta - Background Service Worker
 */

import { startAgent, stopAgent, isAgentRunning } from './background/agent.js';
import {
  getSettings, saveSettings,
  addKey, removeKey, toggleKey, renameKey,
} from './background/settings.js';
import { testOllamaConnection, fetchOllamaModels } from './background/ollama-api.js';

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: 'settings.html' });
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id) openSidePanel(tab.id);
});

chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'toggle-side-panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) openSidePanel(tab.id);
    });
  }
});

async function openSidePanel(tabId) {
  if (!chrome.sidePanel) return;
  chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true });
  chrome.sidePanel.open({ tabId });
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch(e => sendResponse({ success: false, error: e.message }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {

    case 'START_AGENT': {
      const { prompt, tabId } = msg;
      if (!prompt) return { success: false, error: 'Prompt vazio.' };
      if (!tabId)  return { success: false, error: 'tabId ausente.' };
      startAgent(tabId, prompt, event => {
        chrome.runtime.sendMessage({ type: 'AGENT_EVENT', tabId, event }).catch(() => {});
      });
      return { success: true };
    }

    case 'STOP_AGENT': {
      const tabId = msg.tabId ?? sender.tab?.id;
      if (tabId) stopAgent(tabId);
      return { success: true };
    }

    case 'GET_STATUS':
      return { success: true, isRunning: msg.tabId ? isAgentRunning(msg.tabId) : false };

    case 'GET_SETTINGS':
      return { success: true, settings: await getSettings() };

    case 'SAVE_SETTINGS':
      return { success: true, settings: await saveSettings(msg.settings) };

    // ── Gerenciamento de chaves ──
    case 'ADD_KEY': {
      const key = await addKey(msg.key, msg.name);
      return { success: true, key };
    }
    case 'REMOVE_KEY':
      await removeKey(msg.id);
      return { success: true };
    case 'TOGGLE_KEY':
      await toggleKey(msg.id);
      return { success: true };
    case 'RENAME_KEY':
      await renameKey(msg.id, msg.name);
      return { success: true };

    // ── Testar uma chave + modelo ──
    case 'TEST_KEY': {
      const result = await testApiKey(msg.key, msg.model);
      return result;
    }

    case 'GET_MODELS': {
      const result = await fetchModels(msg.apiKey);
      return result;
    }

    case 'TEST_OLLAMA': {
      const result = await testOllamaConnection(msg.baseUrl);
      return result;
    }

    case 'GET_OLLAMA_MODELS': {
      const result = await fetchOllamaModels(msg.baseUrl);
      return result;
    }

    case 'OPEN_SIDEPANEL':
      if (msg.tabId) await openSidePanel(msg.tabId);
      return { success: true };

    case 'GET_CURRENT_TAB': {
      // Se um tabId foi fornecido, validar primeiro
      if (msg.tabId) {
        try {
          const tab = await chrome.tabs.get(msg.tabId);
          if (tab && tab.id) return { success: true, tab };
        } catch (_) {}
      }
      // Fallback: lastFocusedWindow é mais confiável em service workers MV3
      // que currentWindow (que não existe no contexto de service worker)
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      // Ignorar tabs internas do Chrome (chrome://, edge://, about:, etc.)
      if (tab && tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
        return { success: true, tab };
      }
      // Última tentativa: qualquer aba com URL real
      const allActive = await chrome.tabs.query({ active: true });
      const realTab = allActive.find(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('about:'));
      return { success: true, tab: realTab || tab };
    }

    default:
      return { success: false, error: `Mensagem desconhecida: ${msg.type}` };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function testApiKey(apiKey, model = 'gemini-2.5-flash') {
  try {
    const modelPath = model.startsWith('models/') ? model : `models/${model}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });

    if (resp.ok) return { success: true, status: 'ok', label: 'Ativa ✅' };

    const body = await resp.json().catch(() => ({}));
    const errMsg = body?.error?.message || '';

    if (resp.status === 429) return { success: false, status: 'exhausted', label: 'Cota esgotada ⏳' };
    if (errMsg.includes('API_KEY_INVALID')) return { success: false, status: 'invalid', label: 'Chave inválida ❌' };
    if (resp.status === 404 || errMsg.includes('not found')) return { success: false, status: 'unsupported', label: 'Modelo não suportado' };
    return { success: false, status: 'error', label: `Erro ${resp.status}` };

  } catch (e) {
    return { success: false, status: 'network', label: 'Erro de rede' };
  }
}

async function fetchModels(apiKey) {
  if (!apiKey) return { success: false, models: [] };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) return { success: false, models: [] };
    const data = await resp.json();

    const models = (data.models || [])
      .filter(m =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.toLowerCase().includes('gemini') &&
        !m.name.toLowerCase().includes('embedding') &&
        !m.name.toLowerCase().includes('-vision') &&
        !m.name.toLowerCase().includes('aqa')
      )
      .map(m => ({
        id:          m.name.replace('models/', ''),
        fullName:    m.name,
        label:       m.displayName || m.name.replace('models/', ''),
        description: m.description || '',
      }))
      .sort((a, b) => {
        // Ordenar: 2.5 primeiro, depois 2.0, depois 1.5
        const score = id => {
          if (id.includes('2.5')) return 0;
          if (id.includes('2.0')) return 1;
          if (id.includes('1.5')) return 2;
          return 3;
        };
        return score(a.id) - score(b.id);
      });

    return { success: true, models };
  } catch (e) {
    return { success: false, models: [] };
  }
}

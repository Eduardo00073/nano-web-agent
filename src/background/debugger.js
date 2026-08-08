/**
 * Gemini Browser Agent - CDP Debugger Manager
 *
 * Gerencia o ciclo de vida do Chrome DevTools Protocol (CDP).
 * - Mantém um Set de tabIds com debugger já attached.
 * - Evita attach duplo (erro silencioso no Chrome).
 * - Desanexa automaticamente quando a aba é fechada ou navega.
 */

const attachedTabs = new Set();
const pendingAttach = new Map(); // tabId -> Promise

/**
 * Acha o debugger na aba, se ainda não estiver.
 * É seguro chamar múltiplas vezes concorrentemente.
 */
export async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;

  // Evitar race condition de attach duplo
  if (pendingAttach.has(tabId)) {
    return pendingAttach.get(tabId);
  }

  const promise = (async () => {
    // Verificar se a aba existe antes de tentar attach
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) throw new Error(`Aba ${tabId} não existe.`);
      // Não é possível debugar páginas internas do Chrome
      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('about:') || tab.url?.startsWith('chrome-extension://')) {
        throw new Error(`Não é possível controlar páginas internas do Chrome (${tab.url}).`);
      }
    } catch (e) {
      if (e.message.includes('No tab with id') || e.message.includes('não existe')) {
        throw new Error(`Aba não encontrada (ID: ${tabId}). Feche e reabra o painel lateral.`);
      }
      throw e;
    }

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);

      // Habilitar domínios necessários
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
      await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    } catch (e) {
      // "Already attached" é ok
      if (e.message?.includes('already attached')) {
        attachedTabs.add(tabId);
        return;
      }
      throw e;
    } finally {
      pendingAttach.delete(tabId);
    }
  })();

  pendingAttach.set(tabId, promise);
  return promise;
}

/**
 * Desanexa o debugger de uma aba.
 */
export async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {
    // Ignorar erro se a aba já foi fechada
  } finally {
    attachedTabs.delete(tabId);
  }
}

/**
 * Envia um comando CDP e retorna a resposta.
 *
 * @param {number} tabId
 * @param {string} method  - Ex: 'Input.dispatchMouseEvent'
 * @param {object} params  - Parâmetros do comando
 */
export function sendCDP(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result || {});
      }
    });
  });
}

// Limpar tabs fechadas do Set
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

// Desconectar debugger quando o usuário navega (evita "DevTools was detached" spam)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

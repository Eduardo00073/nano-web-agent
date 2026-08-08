/**
 * Gemini Browser Agent - Browser Tools
 *
 * Implementação das ferramentas de controle do browser via Chrome DevTools Protocol (CDP).
 * Cada função recebe { args, tabId } e retorna { content: string, error?: boolean }.
 *
 * Ferramentas disponíveis:
 *   - screenshot        : captura a tela
 *   - read_page         : lê a árvore de acessibilidade
 *   - navigate          : navega para uma URL
 *   - left_click        : clica em coordenadas ou ref_id
 *   - right_click       : clique direito
 *   - double_click      : duplo clique
 *   - triple_click      : seleciona todo o texto de um campo
 *   - type_text         : digita texto (substitui conteúdo)
 *   - key_press         : pressiona tecla (ex: "Enter", "Tab")
 *   - scroll            : rola a página
 *   - hover             : move o mouse
 *   - wait              : aguarda N segundos
 *   - execute_js        : executa JavaScript na página
 *   - get_page_text     : extrai texto puro da página
 *   - find              : busca elemento por seletor CSS / texto
 *   - scroll_to_element : rola até um ref_id ficar visível
 *   - fill_form         : preenche múltiplos campos de uma vez
 *   - tabs_context      : lista tabs abertas no grupo atual
 *   - drag             : arrasta de um ponto a outro (drag & drop)
 *   - zoom             : amplia uma região da tela para ver detalhes
 *   - upload_file      : faz upload de arquivo em input[type=file]
 */

import { attachDebugger, sendCDP, detachDebugger } from './debugger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(content) {
  return { content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) };
}

function err(message) {
  return { content: message, error: true };
}

/**
 * Resolve coordenadas (x,y) a partir de args.
 * Aceita { coordinate: [x,y] } ou { x, y }.
 */
function resolveCoords(args) {
  if (args.coordinate) {
    const [x, y] = args.coordinate;
    return { x: Math.round(x), y: Math.round(y) };
  }
  if (args.x !== undefined && args.y !== undefined) {
    return { x: Math.round(args.x), y: Math.round(args.y) };
  }
  return null;
}

/**
 * Obtém as coordenadas do centro de um elemento identificado por ref_id.
 * Executa via scripting na aba alvo.
 */
async function getCoordsFromRef(tabId, refId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (refId) => {
      const weakRef = window.__geminiElementMap?.[refId];
      if (!weakRef) return null;
      const el = weakRef.deref();
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: rect.width,
        height: rect.height,
      };
    },
    args: [refId],
  });
  return results?.[0]?.result || null;
}

/**
 * Dispara evento de mouse via CDP.
 */
async function mouseEvent(tabId, type, x, y, button = 'left', clickCount = 1) {
  const base = { x, y, button, clickCount, modifiers: 0 };
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

// ─── Ferramentas ─────────────────────────────────────────────────────────────

/**
 * Captura screenshot da aba.
 * Retorna { imageBase64, mimeType } — o background converte para Part do Gemini.
 */
export async function screenshot({ args, tabId }) {
  try {
    await attachDebugger(tabId);
    const result = await sendCDP(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: false,
    });
    return {
      content: 'Screenshot capturado.',
      imageBase64: result.data,
      mimeType: 'image/jpeg',
    };
  } catch (e) {
    return err('Falha ao capturar screenshot: ' + e.message);
  }
}

/**
 * Lê a árvore de acessibilidade da página.
 */
export async function read_page({ args, tabId }) {
  const { filter = 'all', depth, ref_id, max_chars = 50000 } = args || {};
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (filter, depth, maxChars, refId) => {
        if (typeof window.__generateAccessibilityTree !== 'function') {
          return { error: 'Script de acessibilidade não injetado nesta página.', pageContent: '', viewport: {} };
        }
        return window.__generateAccessibilityTree(filter, depth, maxChars, refId);
      },
      args: [filter, depth ?? null, max_chars, ref_id ?? null],
    });

    const data = results?.[0]?.result;
    if (!data) return err('Não foi possível ler a página.');
    if (data.error) return err(data.error);

    const tab = await chrome.tabs.get(tabId);
    const header = `Página: ${tab.title || 'Sem título'}\nURL: ${tab.url}\nViewport: ${data.viewport.width}x${data.viewport.height}\n\n`;
    return ok(header + (data.pageContent || '(página sem conteúdo acessível)'));
  } catch (e) {
    return err('Erro ao ler página: ' + e.message);
  }
}

/**
 * Navega para uma URL na aba.
 */
export async function navigate({ args, tabId }) {
  const { url, new_tab = false } = args;
  if (!url) return err('URL não especificada.');

  try {
    let targetTabId = tabId;

    if (new_tab) {
      const tab = await chrome.tabs.create({ url, active: true });
      targetTabId = tab.id;
    } else {
      await chrome.tabs.update(tabId, { url });
    }

    // Aguarda o carregamento
    await waitForTabLoad(targetTabId);

    const tab = await chrome.tabs.get(targetTabId);
    return ok(`Navegou para: ${tab.url}\nTítulo: ${tab.title}`);
  } catch (e) {
    return err('Erro ao navegar: ' + e.message);
  }
}

/**
 * Aguarda a aba terminar de carregar (timeout: 30s).
 */
function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;

    function check() {
      if (Date.now() > deadline) return resolve();
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return resolve();
        if (tab.status === 'complete') return resolve();
        setTimeout(check, 300);
      });
    }

    check();
  });
}

/**
 * Clique esquerdo em coordenadas ou ref_id.
 */
export async function left_click({ args, tabId }) {
  try {
    await attachDebugger(tabId);

    let coords = resolveCoords(args);

    if (!coords && args.ref_id) {
      coords = await getCoordsFromRef(tabId, args.ref_id);
      if (!coords) return err(`Elemento ref_id="${args.ref_id}" não encontrado.`);
    }

    if (!coords) return err('Forneça coordinate [x,y] ou ref_id.');

    await mouseEvent(tabId, 'click', coords.x, coords.y, 'left', 1);
    return ok(`Clique esquerdo em (${coords.x}, ${coords.y}).`);
  } catch (e) {
    return err('Erro ao clicar: ' + e.message);
  }
}

/**
 * Clique direito.
 */
export async function right_click({ args, tabId }) {
  try {
    await attachDebugger(tabId);

    let coords = resolveCoords(args);
    if (!coords && args.ref_id) {
      coords = await getCoordsFromRef(tabId, args.ref_id);
      if (!coords) return err(`Elemento ref_id="${args.ref_id}" não encontrado.`);
    }
    if (!coords) return err('Forneça coordinate [x,y] ou ref_id.');

    await mouseEvent(tabId, 'click', coords.x, coords.y, 'right', 1);
    return ok(`Clique direito em (${coords.x}, ${coords.y}).`);
  } catch (e) {
    return err('Erro ao clicar com botão direito: ' + e.message);
  }
}

/**
 * Duplo clique.
 */
export async function double_click({ args, tabId }) {
  try {
    await attachDebugger(tabId);

    let coords = resolveCoords(args);
    if (!coords && args.ref_id) {
      coords = await getCoordsFromRef(tabId, args.ref_id);
      if (!coords) return err(`Elemento ref_id="${args.ref_id}" não encontrado.`);
    }
    if (!coords) return err('Forneça coordinate [x,y] ou ref_id.');

    await mouseEvent(tabId, 'dblclick', coords.x, coords.y, 'left', 2);
    return ok(`Duplo clique em (${coords.x}, ${coords.y}).`);
  } catch (e) {
    return err('Erro no duplo clique: ' + e.message);
  }
}

/**
 * Triplo clique — seleciona todo o texto de um campo.
 */
export async function triple_click({ args, tabId }) {
  try {
    await attachDebugger(tabId);

    let coords = resolveCoords(args);
    if (!coords && args.ref_id) {
      coords = await getCoordsFromRef(tabId, args.ref_id);
      if (!coords) return err(`Elemento ref_id="${args.ref_id}" não encontrado.`);
    }
    if (!coords) return err('Forneça coordinate [x,y] ou ref_id.');

    // 3 cliques = seleção de texto
    const base = { x: coords.x, y: coords.y, button: 'left', modifiers: 0 };
    for (let i = 1; i <= 3; i++) {
      await sendCDP(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount: i });
      await sendCDP(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount: i });
    }
    return ok(`Triplo clique em (${coords.x}, ${coords.y}) — texto selecionado.`);
  } catch (e) {
    return err('Erro no triplo clique: ' + e.message);
  }
}

/**
 * Digita texto no elemento focado ou em um ref_id.
 * Se ref_id for fornecido, clica no elemento antes de digitar.
 */
export async function type_text({ args, tabId }) {
  const { text, ref_id, clear_first = false } = args;
  if (text === undefined || text === null) return err('Parâmetro "text" obrigatório.');

  try {
    await attachDebugger(tabId);

    // Focar no elemento, se ref_id fornecido
    if (ref_id) {
      const coords = await getCoordsFromRef(tabId, ref_id);
      if (!coords) return err(`Elemento ref_id="${ref_id}" não encontrado.`);
      await mouseEvent(tabId, 'click', coords.x, coords.y);
      await delay(80);
    }

    // Limpar campo antes, se solicitado
    if (clear_first) {
      await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2, code: 'KeyA' });
      await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'a', modifiers: 2, code: 'KeyA' });
      await delay(50);
      await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete' });
      await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Delete', code: 'Delete' });
      await delay(50);
    }

    // Inserir o texto de uma vez (mais eficiente)
    await sendCDP(tabId, 'Input.insertText', { text: String(text) });

    // Disparar eventos compatíveis com React/Vue/Angular
    // Frameworks modernos monitoram eventos sintéticos via setter nativo
    if (ref_id) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (refId) => {
          const el = window.__geminiElementMap?.[refId]?.deref();
          if (!el) return;
          const tag = el.tagName?.toLowerCase();
          if (tag === 'input' || tag === 'textarea') {
            // Hack React: usa o setter nativo para notificar o framework
            const proto = tag === 'input'
              ? window.HTMLInputElement.prototype
              : window.HTMLTextAreaElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, el.value);
          }
          el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        },
        args: [ref_id],
      });
    }

    return ok(`Texto digitado: "${String(text).substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
  } catch (e) {
    return err('Erro ao digitar texto: ' + e.message);
  }
}

/**
 * Pressiona uma tecla, com suporte a modificadores (Ctrl, Shift, Alt, Meta).
 * Exemplos: key:"a" modifiers:["ctrl"]  →  Ctrl+A (selecionar tudo)
 *           key:"c" modifiers:["ctrl"]  →  Ctrl+C (copiar)
 *           key:"v" modifiers:["ctrl"]  →  Ctrl+V (colar)
 *           key:"z" modifiers:["ctrl"]  →  Ctrl+Z (desfazer)
 *           key:"Enter" modifiers:["shift"]  →  Shift+Enter (nova linha)
 */
export async function key_press({ args, tabId }) {
  const { key, modifiers = [] } = args;
  if (!key) return err('Parâmetro "key" obrigatório. Ex: "Enter", "Tab", "Escape".');

  // Mapa de teclas para keyCode/code CDP
  const keyMap = {
    Enter:      { keyCode: 13, code: 'Enter' },
    Tab:        { keyCode: 9,  code: 'Tab' },
    Escape:     { keyCode: 27, code: 'Escape' },
    Backspace:  { keyCode: 8,  code: 'Backspace' },
    Delete:     { keyCode: 46, code: 'Delete' },
    ArrowUp:    { keyCode: 38, code: 'ArrowUp' },
    ArrowDown:  { keyCode: 40, code: 'ArrowDown' },
    ArrowLeft:  { keyCode: 37, code: 'ArrowLeft' },
    ArrowRight: { keyCode: 39, code: 'ArrowRight' },
    Home:       { keyCode: 36, code: 'Home' },
    End:        { keyCode: 35, code: 'End' },
    PageUp:     { keyCode: 33, code: 'PageUp' },
    PageDown:   { keyCode: 34, code: 'PageDown' },
    ' ':        { keyCode: 32, code: 'Space' },
    F1:  { keyCode: 112, code: 'F1' },  F2:  { keyCode: 113, code: 'F2' },
    F3:  { keyCode: 114, code: 'F3' },  F4:  { keyCode: 115, code: 'F4' },
    F5:  { keyCode: 116, code: 'F5' },  F12: { keyCode: 123, code: 'F12' },
  };

  // Calcular máscara de modificadores (bitmask CDP)
  // ctrl=2, alt=1, shift=8, meta=4
  let modMask = 0;
  const mods = Array.isArray(modifiers) ? modifiers : [];
  if (mods.includes('ctrl'))  modMask |= 2;
  if (mods.includes('alt'))   modMask |= 1;
  if (mods.includes('shift')) modMask |= 8;
  if (mods.includes('meta'))  modMask |= 4;

  // Para teclas de letra (a-z), gerar keyCode a partir do char
  let keyInfo = keyMap[key];
  if (!keyInfo && key.length === 1) {
    const upper = key.toUpperCase();
    keyInfo = {
      keyCode: upper.charCodeAt(0),
      code: 'Key' + upper,
    };
  }
  if (!keyInfo) keyInfo = { keyCode: 0, code: key };

  try {
    await attachDebugger(tabId);

    const params = {
      key,
      code:                  keyInfo.code,
      keyCode:               keyInfo.keyCode,
      windowsVirtualKeyCode: keyInfo.keyCode,
      modifiers:             modMask,
    };

    await sendCDP(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
    await sendCDP(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });

    const modStr = mods.length ? mods.join('+') + '+' : '';
    return ok(`Tecla pressionada: "${modStr}${key}".`);
  } catch (e) {
    return err('Erro ao pressionar tecla: ' + e.message);
  }
}

/**
 * Rola a página na direção especificada.
 * direction: 'up' | 'down' | 'left' | 'right'
 * amount: pixels (padrão: 300)
 */
export async function scroll({ args, tabId }) {
  const { direction = 'down', amount = 300, coordinate } = args;

  try {
    await attachDebugger(tabId);

    // Determina ponto de scroll
    let x, y;
    if (coordinate) {
      [x, y] = coordinate;
    } else {
      // Centro da viewport
      const tab = await chrome.tabs.get(tabId);
      const viewportResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ w: window.innerWidth, h: window.innerHeight }),
      });
      const vp = viewportResult?.[0]?.result || { w: 800, h: 600 };
      x = Math.round(vp.w / 2);
      y = Math.round(vp.h / 2);
    }

    const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    const deltaY = direction === 'down'  ? amount : direction === 'up'   ? -amount : 0;

    await sendCDP(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x, y,
      deltaX, deltaY,
      modifiers: 0,
    });

    return ok(`Rolado ${direction} por ${Math.abs(deltaX || deltaY)}px em (${x}, ${y}).`);
  } catch (e) {
    return err('Erro ao rolar: ' + e.message);
  }
}

/**
 * Move o mouse para coordenadas (hover — revela tooltips, dropdowns).
 */
export async function hover({ args, tabId }) {
  try {
    await attachDebugger(tabId);

    let coords = resolveCoords(args);
    if (!coords && args.ref_id) {
      coords = await getCoordsFromRef(tabId, args.ref_id);
      if (!coords) return err(`Elemento ref_id="${args.ref_id}" não encontrado.`);
    }
    if (!coords) return err('Forneça coordinate [x,y] ou ref_id.');

    await sendCDP(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: coords.x,
      y: coords.y,
      button: 'none',
      modifiers: 0,
    });

    return ok(`Mouse movido para (${coords.x}, ${coords.y}).`);
  } catch (e) {
    return err('Erro ao mover mouse: ' + e.message);
  }
}

/**
 * Aguarda N segundos.
 */
export async function wait({ args }) {
  const seconds = Math.min(Math.max(args?.seconds ?? 1, 0.1), 30);
  await delay(seconds * 1000);
  return ok(`Aguardou ${seconds} segundo(s).`);
}

/**
 * Executa JavaScript arbitrário na página.
 * Retorna o resultado como string.
 */
export async function execute_js({ args, tabId }) {
  const { code } = args;
  if (!code) return err('Parâmetro "code" obrigatório.');

  try {
    await attachDebugger(tabId);

    const result = await sendCDP(tabId, 'Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });

    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      return err(`Exceção JavaScript: ${ex.exception?.description || ex.text}`);
    }

    const value = result.result?.value;
    return ok(value !== undefined ? String(value) : '(undefined)');
  } catch (e) {
    return err('Erro ao executar JavaScript: ' + e.message);
  }
}

/**
 * Extrai o texto limpo da página.
 */
export async function get_page_text({ args, tabId }) {
  const maxChars = args?.max_chars ?? 20000;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxChars) => {
        const text = document.body?.innerText || '';
        const clean = text.replace(/\s+/g, ' ').trim();
        if (clean.length > maxChars) {
          return { text: clean.substring(0, maxChars), truncated: true, total: clean.length };
        }
        return { text: clean, truncated: false };
      },
      args: [maxChars],
    });

    const data = results?.[0]?.result;
    if (!data) return err('Não foi possível extrair texto.');

    const suffix = data.truncated ? `\n\n[Truncado: ${data.total} chars no total]` : '';
    return ok(data.text + suffix);
  } catch (e) {
    return err('Erro ao extrair texto: ' + e.message);
  }
}

/**
 * Busca elemento por seletor CSS ou texto visível.
 * Retorna o ref_id para uso em outras ferramentas.
 */
export async function find({ args, tabId }) {
  const { selector, text, filter = 'all' } = args;
  if (!selector && !text) return err('Forneça "selector" (CSS) ou "text".');

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector, searchText) => {
        let el = null;

        if (selector) {
          el = document.querySelector(selector);
        } else if (searchText) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.textContent.includes(searchText)) {
              el = node.parentElement;
              break;
            }
          }
        }

        if (!el) return null;

        window.__geminiElementMap = window.__geminiElementMap || {};
        window.__geminiRefCounter = window.__geminiRefCounter || 0;

        for (const id in window.__geminiElementMap) {
          if (window.__geminiElementMap[id].deref() === el) {
            const rect = el.getBoundingClientRect();
            return { refId: id, tag: el.tagName.toLowerCase(), x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) };
          }
        }

        const id = 'ref_' + (++window.__geminiRefCounter);
        window.__geminiElementMap[id] = new WeakRef(el);
        const rect = el.getBoundingClientRect();
        return { refId: id, tag: el.tagName.toLowerCase(), x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) };
      },
      args: [selector ?? null, text ?? null],
    });

    const data = results?.[0]?.result;
    if (!data) return err(`Elemento não encontrado: ${selector || text}`);

    return ok(`Encontrado: <${data.tag}> [${data.refId}] em (${data.x}, ${data.y})`);
  } catch (e) {
    return err('Erro ao buscar elemento: ' + e.message);
  }
}

/**
 * Rola a página até o elemento com ref_id ficar visível na viewport.
 * Usa CDP DOM.scrollIntoViewIfNeeded (mais preciso para containers com overflow)
 * com fallback para JS scrollIntoView.
 */
export async function scroll_to_element({ args, tabId }) {
  const { ref_id } = args;
  if (!ref_id) return err('Parâmetro "ref_id" obrigatório.');

  try {
    await attachDebugger(tabId);

    // Tenta via CDP DOM.scrollIntoViewIfNeeded (mais preciso)
    const evalResult = await sendCDP(tabId, 'Runtime.evaluate', {
      expression: 'window.__geminiElementMap?.["' + ref_id + '"]?.deref() || null',
      returnByValue: false,
    });

    if (evalResult?.result?.objectId) {
      try {
        const { nodeId } = await sendCDP(tabId, 'DOM.requestNode', {
          objectId: evalResult.result.objectId,
        });
        if (nodeId) {
          await sendCDP(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId });
          await delay(300);
          return ok(`Elemento [${ref_id}] visível.`);
        }
      } catch (_) {
        // Fallback abaixo
      }
    }

    // Fallback: JS scrollIntoView
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (refId) => {
        const weakRef = window.__geminiElementMap?.[refId];
        if (!weakRef) return { error: 'ref_id não encontrado.' };
        const el = weakRef.deref();
        if (!el) return { error: 'Elemento não existe mais.' };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { success: true };
      },
      args: [ref_id],
    });

    const data = results?.[0]?.result;
    if (data?.error) return err(data.error);
    return ok(`Elemento [${ref_id}] visível.`);
  } catch (e) {
    return err('Erro ao rolar até elemento: ' + e.message);
  }
}

/**
 * Preenche múltiplos campos de formulário de uma vez.
 * fields: [{ ref_id: "ref_X", value: "..." }, ...]
 */
export async function fill_form({ args, tabId }) {
  const { fields } = args;
  if (!Array.isArray(fields) || fields.length === 0) {
    return err('Parâmetro "fields" deve ser um array com { ref_id, value }.');
  }

  const results = [];

  for (const field of fields) {
    const result = await type_text({
      args: { ref_id: field.ref_id, text: field.value, clear_first: true },
      tabId,
    });
    results.push(`[${field.ref_id}]: ${result.error ? 'ERRO — ' + result.content : 'OK'}`);
    await delay(150);
  }

  return ok(`Formulário preenchido:\n${results.join('\n')}`);
}

/**
 * Lê mensagens do console JavaScript da página.
 * Captura logs, warnings e erros que foram registrados.
 */
export async function read_console_messages({ args, tabId }) {
  const maxMessages = args?.max_messages ?? 50;

  try {
    await attachDebugger(tabId);

    // Injetar interceptor de console se ainda não foi injetado
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__deltaConsoleMessages) return;
        window.__deltaConsoleMessages = [];
        const _capture = (level) => {
          const orig = console[level];
          console[level] = function (...args) {
            try {
              window.__deltaConsoleMessages.push({
                level,
                message: args.map(a => {
                  try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
                  catch (_) { return String(a); }
                }).join(' '),
                timestamp: Date.now(),
              });
              if (window.__deltaConsoleMessages.length > 200) {
                window.__deltaConsoleMessages.shift();
              }
            } catch (_) {}
            return orig.apply(console, args);
          };
        };
        ['log', 'warn', 'error', 'info', 'debug'].forEach(_capture);
      },
    });

    // Buscar mensagens já capturadas + erros da página via CDP
    const cdpLogs = await sendCDP(tabId, 'Runtime.evaluate', {
      expression: `(window.__deltaConsoleMessages || []).slice(-${maxMessages})`,
      returnByValue: true,
    });

    const messages = cdpLogs?.result?.value || [];

    if (!messages.length) {
      return ok('Nenhuma mensagem no console (ou página recarregada recentemente).');
    }

    const formatted = messages.map(m =>
      `[${m.level?.toUpperCase() || 'LOG'}] ${m.message}`
    ).join('\n');

    return ok(`Console (${messages.length} mensagem(ns)):\n${formatted}`);
  } catch (e) {
    return err('Erro ao ler console: ' + e.message);
  }
}

/**
 * Lista as tabs abertas na janela atual.
 */
export async function tabs_context({ args, tabId }) {
  try {
    const currentTab = await chrome.tabs.get(tabId);
    const tabs = await chrome.tabs.query({ windowId: currentTab.windowId });

    const list = tabs.map((t) => ({
      tabId: t.id,
      title: t.title?.substring(0, 80) || '',
      url: t.url || '',
      active: t.active,
    }));

    return ok(JSON.stringify(list, null, 2));
  } catch (e) {
    return err('Erro ao listar tabs: ' + e.message);
  }
}

/**
 * Arrasta o mouse do ponto de origem até o destino com movimento suave.
 * Use para: sliders, reordenar listas, kanban, redimensionar janelas, selecionar área.
 */
export async function drag({ args, tabId }) {
  const { start_coordinate, end_coordinate, steps = 20 } = args;
  if (!start_coordinate || !end_coordinate) {
    return err('Parâmetros "start_coordinate" e "end_coordinate" obrigatórios.');
  }

  const [startX, startY] = start_coordinate.map(Math.round);
  const [endX,   endY]   = end_coordinate.map(Math.round);

  try {
    await attachDebugger(tabId);

    // 1. Mover para a origem e pressionar
    await sendCDP(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: startX, y: startY,
      button: 'none', buttons: 0,
    });
    await sendCDP(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: startX, y: startY,
      button: 'left', buttons: 1, clickCount: 1,
    });

    // 2. Mover em incrementos suaves (~60fps)
    const numSteps = Math.max(1, steps);
    for (let i = 1; i <= numSteps; i++) {
      const x = Math.round(startX + (endX - startX) * i / numSteps);
      const y = Math.round(startY + (endY - startY) * i / numSteps);
      await sendCDP(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y,
        button: 'left', buttons: 1,
      });
      await delay(16);
    }

    // 3. Soltar no destino
    await sendCDP(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: endX, y: endY,
      button: 'left', buttons: 0, clickCount: 1,
    });

    return ok(`Arrastado de (${startX},${startY}) até (${endX},${endY}) em ${numSteps} passos.`);
  } catch (e) {
    return err('Erro ao arrastar: ' + e.message);
  }
}

/**
 * Amplia uma região específica da tela para ver detalhes.
 * region: [x, y, width, height] em pixels da viewport.
 * Retorna screenshot recortado e ampliado 2x.
 */
export async function zoom({ args, tabId }) {
  const { region } = args;
  if (!Array.isArray(region) || region.length < 4) {
    return err('Parâmetro "region" obrigatório: [x, y, width, height].');
  }

  const [x, y, w, h] = region.map(Number);
  if (w <= 0 || h <= 0) return err('Largura e altura da região devem ser positivas.');

  try {
    await attachDebugger(tabId);
    const result = await sendCDP(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 92,
      clip: { x, y, width: w, height: h, scale: 2 },
    });

    return {
      content: `Zoom em região (${x},${y}) ${w}x${h}px — ampliado 2x.`,
      imageBase64: result.data,
      mimeType: 'image/jpeg',
    };
  } catch (e) {
    return err('Erro ao ampliar região: ' + e.message);
  }
}

/**
 * Faz upload de arquivo(s) em um input[type=file].
 * Usa CDP DOM.setFileInputFiles — não abre o seletor de arquivo do OS.
 * file_paths deve conter caminhos absolutos no sistema.
 */
export async function upload_file({ args, tabId }) {
  const { ref_id, file_paths } = args;
  if (!ref_id) return err('Parâmetro "ref_id" obrigatório.');
  if (!Array.isArray(file_paths) || !file_paths.length) {
    return err('Parâmetro "file_paths" obrigatório: array com caminhos absolutos.');
  }

  try {
    await attachDebugger(tabId);

    // Obter o objectId do elemento via Runtime
    const evalResult = await sendCDP(tabId, 'Runtime.evaluate', {
      expression: 'window.__geminiElementMap?.["' + ref_id + '"]?.deref() || null',
      returnByValue: false,
    });

    if (!evalResult?.result?.objectId) {
      return err(`Elemento ref_id="${ref_id}" não encontrado. Use read_page para obter um ref_id válido.`);
    }

    // Resolver objectId → nodeId DOM
    const { nodeId } = await sendCDP(tabId, 'DOM.requestNode', {
      objectId: evalResult.result.objectId,
    });

    if (!nodeId) return err('Não foi possível resolver o nodeId do elemento.');

    // Definir arquivos diretamente no input[type=file]
    await sendCDP(tabId, 'DOM.setFileInputFiles', {
      nodeId,
      files: file_paths,
    });

    // Disparar evento change
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (refId) => {
        const el = window.__geminiElementMap?.[refId]?.deref();
        if (el) {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input',  { bubbles: true }));
        }
      },
      args: [ref_id],
    });

    return ok(`Upload configurado em [${ref_id}]: ${file_paths.join(', ')}`);
  } catch (e) {
    return err('Erro ao fazer upload: ' + e.message);
  }
}

// ─── Utilitários ─────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Despacha uma ferramenta pelo nome.
 * Usado pelo agente loop em background.js.
 */
export const TOOLS = {
  screenshot,
  read_page,
  navigate,
  left_click,
  right_click,
  double_click,
  triple_click,
  type_text,
  key_press,
  scroll,
  hover,
  drag,
  zoom,
  upload_file,
  wait,
  execute_js,
  get_page_text,
  find,
  scroll_to_element,
  fill_form,
  tabs_context,
  read_console_messages,
};

export async function executeTool(toolName, args, tabId) {
  const fn = TOOLS[toolName];
  if (!fn) {
    return err(`Ferramenta desconhecida: "${toolName}". Ferramentas disponíveis: ${Object.keys(TOOLS).join(', ')}`);
  }
  return fn({ args: args || {}, tabId });
}

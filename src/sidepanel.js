/**
 * Gemini Browser Agent - Sidepanel UI Controller
 *
 * Gerencia a interface do painel lateral:
 * - Envia prompts ao background (START_AGENT)
 * - Exibe eventos do agente em tempo real (AGENT_EVENT)
 * - Gerencia estado visual (rodando / parado)
 */

// ─── Estado ───────────────────────────────────────────────────────────────────

let currentTabId = null;
let isRunning = false;

// ─── Elementos DOM ────────────────────────────────────────────────────────────

const messagesEl   = document.getElementById('messages');
const promptInput  = document.getElementById('prompt-input');
const sendBtn      = document.getElementById('send-btn');
const stopBtn      = document.getElementById('stop-btn');
const statusText   = document.getElementById('status-text');
const statusBar    = document.getElementById('status-bar');
const clearBtn     = document.getElementById('clear-btn');
const settingsBtn  = document.getElementById('settings-btn');

// ─── Inicialização ────────────────────────────────────────────────────────────

async function init() {
  // Obter tab atual — passa o tabId da URL como hint para validação no background
  const params = new URLSearchParams(window.location.search);
  const urlTabId = params.get('tabId') ? parseInt(params.get('tabId'), 10) : null;

  const resp = await sendMessage({ type: 'GET_CURRENT_TAB', tabId: urlTabId });
  if (resp?.tab?.id) {
    currentTabId = resp.tab.id;
  } else if (urlTabId) {
    currentTabId = urlTabId;
  }

  // Verificar se há agente rodando
  if (currentTabId) {
    const statusResp = await sendMessage({ type: 'GET_STATUS', tabId: currentTabId });
    if (statusResp?.isRunning) setRunning(true);
  }

  // Event listeners
  sendBtn.addEventListener('click', handleSend);
  stopBtn.addEventListener('click', handleStop);
  clearBtn.addEventListener('click', handleClear);
  settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-resize textarea
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
  });

  // Escutar eventos do agente vindos do background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AGENT_EVENT' && msg.tabId === currentTabId) {
      handleAgentEvent(msg.event);
    }
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSend() {
  const prompt = promptInput.value.trim();
  if (!prompt || isRunning) return;
  if (!currentTabId) {
    setStatus('Nenhuma aba ativa encontrada.', 'error');
    return;
  }

  // Verificar chave de API
  const settingsResp = await sendMessage({ type: 'GET_SETTINGS' });
  const apiKeys = settingsResp?.settings?.apiKeys || [];
  if (!apiKeys.some(k => k.active)) {
    addMessage('error', 'Nenhuma chave de API configurada. Clique no ícone de configurações para adicionar uma.');
    return;
  }

  // Adicionar mensagem do usuário na UI
  addMessage('user', prompt);
  promptInput.value = '';
  promptInput.style.height = 'auto';

  setRunning(true);

  // Enviar para o background
  const resp = await sendMessage({
    type: 'START_AGENT',
    prompt,
    tabId: currentTabId,
  });

  if (!resp?.success) {
    addMessage('error', resp?.error || 'Falha ao iniciar o agente.');
    setRunning(false);
  }
}

async function handleStop() {
  if (!currentTabId) return;
  await sendMessage({ type: 'STOP_AGENT', tabId: currentTabId });
  setRunning(false);
  setStatus('Parado pelo usuário.', 'idle');
}

function handleClear() {
  messagesEl.innerHTML = '';
  setStatus('Pronto', 'idle');
}

// ─── Eventos do Agente ────────────────────────────────────────────────────────

function handleAgentEvent(event) {
  switch (event.type) {

    case 'start':
      setStatus('Agente iniciado...', 'running');
      break;

    case 'thinking':
      setStatus(`Pensando (turno ${event.turn})...`, 'running');
      break;

    case 'status':
      setStatus(event.message, 'running');
      break;

    case 'text':
      if (event.text.trim()) addMessage('agent', event.text);
      break;

    case 'tool_call':
      addToolCall(event.tool, event.args);
      setStatus(`Executando: ${event.tool}...`, 'running');
      break;

    case 'tool_result':
      if (event.isError) {
        addMessage('error', `${event.tool}: ${event.result}`);
      } else if (event.imageBase64) {
        addScreenshot(event.imageBase64, event.mimeType);
      }
      break;

    case 'complete':
      addMessage('agent', event.message || 'Tarefa concluída.');
      setRunning(false);
      setStatus('Concluído', 'idle');
      break;

    case 'error':
      addMessage('error', event.message || 'Erro desconhecido.');
      setRunning(false);
      setStatus('Erro', 'error');
      break;

    case 'done':
      setRunning(false);
      if (event.totalTurns) {
        setStatus(`Finalizado em ${event.totalTurns} turno(s)`, 'idle');
      }
      break;
  }
}

// ─── Utilitários de UI ────────────────────────────────────────────────────────

function setRunning(running) {
  isRunning = running;
  sendBtn.disabled = running;
  stopBtn.classList.toggle('visible', running);
  promptInput.disabled = running;

  if (!running) setStatus('Pronto', 'idle');
}

function setStatus(text, state = 'idle') {
  statusText.textContent = text;
  statusBar.className = state;

  // Spinner para estado rodando
  const existingSpinner = statusBar.querySelector('.spinner');
  if (state === 'running' && !existingSpinner) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    statusBar.insertBefore(spinner, statusBar.firstChild);
  } else if (state !== 'running' && existingSpinner) {
    existingSpinner.remove();
  }
}

function addMessage(type, text) {
  const el = document.createElement('div');

  if (type === 'user') {
    el.className = 'msg-user';
    el.textContent = text;
  } else if (type === 'agent') {
    el.className = 'msg-agent';
    el.innerHTML = formatText(text);
  } else if (type === 'error') {
    el.className = 'msg-error';
    el.textContent = text;
  }

  messagesEl.appendChild(el);
  scrollToBottom();
}

function addStatusBubble(text) {
  // Mostrar mensagens de rotação de chave/modelo como bolha discreta
  if (!text?.includes('🔄') && !text?.includes('⚡')) return;
  const el = document.createElement('div');
  el.className = 'msg-status';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addToolCall(toolName, args) {
  const el = document.createElement('div');
  el.className = 'msg-action';

  const argsStr = Object.entries(args || {})
    .map(([k, v]) => `${k}: ${JSON.stringify(v).substring(0, 80)}`)
    .join(', ');

  el.innerHTML = `
    <div class="tool-name">⚙ ${escapeHtml(toolName)}</div>
    ${argsStr ? `<div class="tool-args">${escapeHtml(argsStr)}</div>` : ''}
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addScreenshot(base64, mimeType = 'image/jpeg') {
  const el = document.createElement('div');
  el.className = 'msg-screenshot';

  const img = document.createElement('img');
  img.src = `data:${mimeType};base64,${base64}`;
  img.alt = 'Screenshot';
  img.loading = 'lazy';

  // Expandir em nova aba ao clicar
  img.addEventListener('click', () => {
    const win = window.open();
    win.document.write(`<img src="${img.src}" style="max-width:100%;"/>`);
  });

  el.appendChild(img);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatText(text) {
  // Markdown básico: **bold**, `code`, newlines
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#f1f3f4;padding:1px 4px;border-radius:3px;font-family:monospace;">$1</code>')
    .replace(/\n/g, '<br>');
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

init().catch(console.error);

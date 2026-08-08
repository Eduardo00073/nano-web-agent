/**
 * Delta Agent — Settings Page Controller
 */

let currentSettings = null;
let allModels       = [];
let selectedModel   = '';

// ── Full static model list (fallback when API is unavailable) ──────────────
const STATIC_MODELS = [
  // 2.5
  { id: 'gemini-2.5-pro',                  label: 'Gemini 2.5 Pro',                  description: 'Most intelligent — advanced reasoning' },
  { id: 'gemini-2.5-pro-preview-05-06',    label: 'Gemini 2.5 Pro Preview (05-06)',  description: 'Latest 2.5 Pro preview' },
  { id: 'gemini-2.5-pro-exp-03-25',        label: 'Gemini 2.5 Pro Exp (03-25)',      description: 'Experimental 2.5 Pro build' },
  { id: 'gemini-2.5-flash',                label: 'Gemini 2.5 Flash ✅',             description: 'Fast & efficient — Free tier OK — RECOMMENDED' },
  { id: 'gemini-2.5-flash-preview-04-17',  label: 'Gemini 2.5 Flash Preview (04-17)',description: 'Latest 2.5 Flash preview' },
  // 2.0
  { id: 'gemini-2.0-flash',                label: 'Gemini 2.0 Flash',                description: 'Fast multimodal — stable' },
  { id: 'gemini-2.0-flash-exp',            label: 'Gemini 2.0 Flash Exp',            description: 'Experimental 2.0 Flash build' },
  { id: 'gemini-2.0-flash-lite',           label: 'Gemini 2.0 Flash-Lite',           description: 'Ultra-light and economical' },
  { id: 'gemini-2.0-flash-thinking-exp',   label: 'Gemini 2.0 Flash Thinking',       description: 'Chain-of-thought reasoning (experimental)' },
  { id: 'gemini-2.0-pro-exp',              label: 'Gemini 2.0 Pro Exp',              description: 'Experimental 2.0 Pro build' },
  // 1.5
  { id: 'gemini-1.5-pro',                  label: 'Gemini 1.5 Pro',                  description: '1M token context — robust' },
  { id: 'gemini-1.5-pro-latest',           label: 'Gemini 1.5 Pro Latest',           description: 'Latest stable 1.5 Pro' },
  { id: 'gemini-1.5-flash',                label: 'Gemini 1.5 Flash',                description: 'Generous free tier — very stable' },
  { id: 'gemini-1.5-flash-latest',         label: 'Gemini 1.5 Flash Latest',         description: 'Latest stable 1.5 Flash' },
  { id: 'gemini-1.5-flash-8b',             label: 'Gemini 1.5 Flash 8B',             description: 'Compact and fast' },
  { id: 'gemini-1.5-flash-8b-latest',      label: 'Gemini 1.5 Flash 8B Latest',      description: 'Latest Flash 8B build' },
];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  currentSettings = (await sendMsg({ type: 'GET_SETTINGS' }))?.settings || {};
  selectedModel   = currentSettings.model || 'gemini-2.5-flash';
  allModels       = [...STATIC_MODELS];

  setupTabs();
  setupKeys();
  renderModelsTable();
  setupModelFallback();
  setupPrefs();
  setupOllama();

  // Auto-fetch models if an active key exists
  const activeKey = (currentSettings.apiKeys || []).find(k => k.active);
  if (activeKey) fetchModelsFromAPI(activeKey.key, true); // silent=true
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

function setupKeys() {
  const input     = document.getElementById('new-key-input');
  const nameInput = document.getElementById('new-key-name');
  const toggleBtn = document.getElementById('toggle-new-key');
  const addBtn    = document.getElementById('add-key-btn');
  const testAllBtn = document.getElementById('test-all-keys-btn');

  toggleBtn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggleBtn.textContent = show ? 'Ocultar' : 'Mostrar';
  });

  input.addEventListener('paste', e => {
    e.preventDefault();
    input.value = (e.clipboardData || window.clipboardData).getData('text').replace(/\s+/g, '');
  });

  addBtn.addEventListener('click', async () => {
    const key  = input.value.replace(/\s+/g, '');
    const name = nameInput.value.trim();
    if (!key) { flash('Cole a chave no campo', 'err'); return; }
    if (!key.startsWith('AIza')) { flash('Chave inválida — deve começar com "AIza"', 'err'); return; }

    addBtn.disabled = true; addBtn.textContent = 'Adicionando...';
    const r = await sendMsg({ type: 'ADD_KEY', key, name });
    addBtn.disabled = false; addBtn.textContent = '+ Adicionar Chave';

    if (r?.success) {
      flash('Chave adicionada!', 'ok');
      input.value = ''; nameInput.value = '';
      await refreshSettings(); renderKeys();
      // Tentar auto-fetch de modelos com a nova chave
      fetchModelsFromAPI(key, true);
    } else {
      flash(r?.error || 'Erro ao adicionar', 'err');
    }
  });

  testAllBtn.addEventListener('click', testAllKeys);

  // Event delegation for dynamically-generated key action buttons
  document.getElementById('keys-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    const action = btn.dataset.action;
    if (action === 'rename') renameKeyPrompt(id);
    else if (action === 'toggle') doToggleKey(id);
    else if (action === 'remove') doRemoveKey(id);
  });

  renderKeys();
}

async function renderKeys() {
  const s      = currentSettings;
  const keys   = s.apiKeys || [];
  const wrap   = document.getElementById('keys-list');
  document.getElementById('key-count-text').textContent =
    `${keys.length} / 10 chaves  ·  Fallback automático em matriz (Chaves × Modelos)`;

  if (!keys.length) {
    wrap.innerHTML = `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
      </svg>
      <p>Nenhuma chave cadastrada.<br>Adicione sua primeira chave acima.</p>
    </div>`;
    return;
  }

  const activeKeys = keys.filter(k => k.active);
  let activePos = 0;

  const rows = keys.map((k, i) => {
    if (k.active) activePos++;
    const order   = k.active ? activePos : '—';
    const isCurrent = k.active && activePos - 1 === (s.currentKeyIndex || 0) % Math.max(activeKeys.length, 1);
    const mask    = k.key.substring(0, 8) + '••••••' + k.key.slice(-4);
    const badge   = k.active
      ? `<span class="badge badge-active">● Ativa</span>`
      : `<span class="badge badge-inactive">○ Inativa</span>`;
    const curr    = isCurrent ? `<span class="current-key-indicator">▶ Em uso</span>` : '';

    return `<tr>
      <td class="key-order">${order}</td>
      <td class="key-name-cell"><span>${esc(k.name || `Chave ${i+1}`)}</span> ${curr}</td>
      <td><span class="key-mask">${mask}</span></td>
      <td>${badge}</td>
      <td id="ks-${k.id}"><span class="badge badge-inactive">—</span></td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" data-action="rename" data-id="${k.id}">Renomear</button>
          <button class="btn btn-sm" data-action="toggle" data-id="${k.id}">${k.active ? 'Desativar' : 'Ativar'}</button>
          <button class="btn btn-sm btn-danger" data-action="remove" data-id="${k.id}">Remover</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="keys-table">
    <thead><tr><th>#</th><th>Nome</th><th>Chave</th><th>Status</th><th>Teste</th><th>Ações</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function testAllKeys() {
  const keys  = currentSettings.apiKeys || [];
  if (!keys.length) { flash('Nenhuma chave para testar', 'err'); return; }
  const model = currentSettings.model || 'gemini-2.5-flash';

  for (const k of keys) {
    const cell = document.getElementById(`ks-${k.id}`);
    if (cell) cell.innerHTML = `<span class="badge badge-testing dots">Testando</span>`;
    const r = await sendMsg({ type: 'TEST_KEY', key: k.key, model });
    if (cell) {
      const cls = r?.status === 'ok' ? 'badge-ok' : r?.status === 'exhausted' ? 'badge-exhausted' : 'badge-error';
      cell.innerHTML = `<span class="badge ${cls}">${r?.label || '?'}</span>`;
    }
  }
  flash('Teste concluído!', 'ok');
}

async function doToggleKey(id) {
  await sendMsg({ type: 'TOGGLE_KEY', id });
  await refreshSettings(); renderKeys();
}
async function doRemoveKey(id) {
  if (!confirm('Remover esta chave?')) return;
  await sendMsg({ type: 'REMOVE_KEY', id });
  await refreshSettings(); renderKeys();
  flash('Chave removida', 'ok');
}
async function renameKeyPrompt(id) {
  const name = prompt('Novo nome:');
  if (!name) return;
  await sendMsg({ type: 'RENAME_KEY', id, name: name.trim() });
  await refreshSettings(); renderKeys();
}

// ─── Models ───────────────────────────────────────────────────────────────────

function renderModelsTable() {
  const wrap  = document.getElementById('models-table-wrap');
  const label = document.getElementById('current-model-text');
  const cur   = allModels.find(m => m.id === selectedModel);
  label.textContent = cur ? `${cur.label} — ${cur.id}` : selectedModel;

  const rows = allModels.map(m => {
    const safeId  = m.id.replace(/[\.\-]/g, '_');
    const checked = m.id === selectedModel ? 'checked' : '';
    return `<tr>
      <td style="width:36px;text-align:center">
        <input type="radio" class="radio-btn" name="model-radio" value="${esc(m.id)}" ${checked}/>
      </td>
      <td class="model-id">${esc(m.id)}</td>
      <td>${esc(m.label)}</td>
      <td class="model-desc">${esc(m.description || '')}</td>
      <td id="ms-${safeId}"><span class="badge badge-inactive">—</span></td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="models-table">
    <thead><tr><th></th><th>ID do Modelo</th><th>Nome</th><th>Descrição</th><th>Teste</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function selectModel(id) {
  selectedModel = id;
  await sendMsg({ type: 'SAVE_SETTINGS', settings: { model: id } });
  await refreshSettings();
  const m = allModels.find(m => m.id === id);
  document.getElementById('current-model-text').textContent =
    m ? `${m.label} — ${m.id}` : id;
  flash(`Modelo principal: ${id}`, 'ok');
  updateFallbackList();
}

async function fetchModelsFromAPI(apiKey, silent = false) {
  const btn     = document.getElementById('fetch-models-btn');
  const loading = document.getElementById('models-loading');

  if (!apiKey) {
    const keys  = currentSettings.apiKeys || [];
    const active = keys.find(k => k.active);
    if (!active) { if (!silent) flash('Adicione uma chave de API primeiro', 'err'); return; }
  apiKey = active.key;
  }

  btn.disabled = true; btn.textContent = '↻ Buscando...';
  if (!silent) { loading.style.display = 'block'; document.getElementById('models-table-wrap').innerHTML = ''; }

  const r = await sendMsg({ type: 'GET_MODELS', apiKey });

  loading.style.display = 'none';
  btn.disabled = false; btn.textContent = '↻ Buscar da API';

  if (r?.success && r.models?.length) {
    // Mesclar com estáticos: modelos da API têm prioridade, estáticos servem de base
    const apiIds = new Set(r.models.map(m => m.id));
    const merged = [
      ...r.models,
      ...STATIC_MODELS.filter(m => !apiIds.has(m.id)),
    ];
    allModels = merged;
    if (!silent) flash(`${r.models.length} modelos carregados da API`, 'ok');
  } else {
    allModels = [...STATIC_MODELS];
    if (!silent) flash('API indisponível — usando lista padrão', 'err');
  }

  renderModelsTable();
  updateFallbackList();
}

async function testAllModels() {
  const keys  = currentSettings.apiKeys || [];
  const key   = keys.find(k => k.active);
  if (!key) { flash('Adicione uma chave de API primeiro', 'err'); return; }

  const btn  = document.getElementById('test-all-models-btn');
  const prog = document.getElementById('test-models-progress');
  btn.disabled = true;

  for (let i = 0; i < allModels.length; i++) {
    const m     = allModels[i];
    const safeId = m.id.replace(/[\.\-]/g, '_');
    const cell   = document.getElementById(`ms-${safeId}`);
    prog.textContent = `${i+1} / ${allModels.length}`;
    if (cell) cell.innerHTML = `<span class="badge badge-testing dots">Testando</span>`;

    const r = await sendMsg({ type: 'TEST_KEY', key: key.key, model: m.id });
    if (cell) {
      const cls = r?.status === 'ok' ? 'badge-ok' : r?.status === 'exhausted' ? 'badge-exhausted' : 'badge-error';
      cell.innerHTML = `<span class="badge ${cls}">${r?.label || '?'}</span>`;
    }
    await delay(100);
  }

  btn.disabled = false;
  prog.textContent = '✓ Concluído';
  flash('Teste de modelos concluído!', 'ok');
}

// ─── Model Fallback ───────────────────────────────────────────────────────────

function setupModelFallback() {
  document.getElementById('fetch-models-btn').addEventListener('click', () => fetchModelsFromAPI(null, false));
  document.getElementById('test-all-models-btn').addEventListener('click', testAllModels);
  document.getElementById('save-fallback-btn').addEventListener('click', saveFallbackList);
  document.getElementById('fallback-toggle').addEventListener('change', async (e) => {
    await sendMsg({ type: 'SAVE_SETTINGS', settings: { modelFallbackEnabled: e.target.checked } });
    await refreshSettings();
    document.getElementById('fallback-list-wrap').style.display = e.target.checked ? '' : 'none';
  });

  // Event delegation for model radio buttons (dynamically rendered)
  document.getElementById('models-table-wrap').addEventListener('change', (e) => {
    if (e.target.name === 'model-radio') selectModel(e.target.value);
  });

  // Event delegation for fallback move/remove buttons
  document.getElementById('fallback-order-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === 'move-fallback') moveFallback(id, parseInt(btn.dataset.dir, 10));
    else if (action === 'remove-fallback') removeFallback(id);
  });

  updateFallbackList();
}

function updateFallbackList() {
  const s     = currentSettings;
  const wrap  = document.getElementById('fallback-order-list');
  const tog   = document.getElementById('fallback-toggle');
  const listWrap = document.getElementById('fallback-list-wrap');

  tog.checked = s.modelFallbackEnabled !== false;
  listWrap.style.display = tog.checked ? '' : 'none';

  const list  = s.modelFallbackList?.length
    ? s.modelFallbackList
    : allModels.map(m => m.id);

  // Ensure primary model is at the top
  const primary = s.model || 'gemini-2.5-flash';
  const ordered = [primary, ...list.filter(id => id !== primary)];

  wrap.innerHTML = ordered.map((id, i) => {
    const m = allModels.find(m => m.id === id);
    return `<div class="fallback-item" data-id="${esc(id)}">
      <span class="fallback-pos">${i+1}</span>
      <span class="fallback-name">${esc(m?.label || id)}</span>
      <span class="fallback-id">${esc(id)}</span>
      ${i === 0 ? '<span class="badge badge-active" style="font-size:10px">Principal</span>' : `
      <button class="btn btn-sm" data-action="move-fallback" data-id="${esc(id)}" data-dir="-1">↑</button>
      <button class="btn btn-sm" data-action="remove-fallback" data-id="${esc(id)}">✕</button>`}
    </div>`;
  }).join('');
}

async function saveFallbackList() {
  const items = [...document.querySelectorAll('.fallback-item')].map(el => el.dataset.id);
  await sendMsg({ type: 'SAVE_SETTINGS', settings: { modelFallbackList: items } });
  await refreshSettings();
  flash('Ordem de fallback salva!', 'ok');
}

async function moveFallback(id, dir) {
  const s    = currentSettings;
  const list = [...(s.modelFallbackList || allModels.map(m => m.id))];
  const idx  = list.indexOf(id);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 1 || newIdx >= list.length) return; // não pode ir antes da posição 1 (principal é fixo)
  [list[idx], list[newIdx]] = [list[newIdx], list[idx]];
  await sendMsg({ type: 'SAVE_SETTINGS', settings: { modelFallbackList: list } });
  await refreshSettings();
  updateFallbackList();
}

async function removeFallback(id) {
  const s    = currentSettings;
  const list = (s.modelFallbackList || allModels.map(m => m.id)).filter(i => i !== id);
  await sendMsg({ type: 'SAVE_SETTINGS', settings: { modelFallbackList: list } });
  await refreshSettings();
  updateFallbackList();
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

function setupOllama() {
  const s = currentSettings;

  // Restaurar URL salva
  const urlInput = document.getElementById('ollama-url');
  if (s.ollamaBaseUrl) urlInput.value = s.ollamaBaseUrl;

  // Marcar provider atual
  const provider = s.provider || 'gemini';
  const radio = document.querySelector(`input[name="provider"][value="${provider}"]`);
  if (radio) radio.checked = true;
  updateProviderCards(provider);

  // Listeners dos radio buttons de provider
  document.querySelectorAll('input[name="provider"]').forEach(r => {
    r.addEventListener('change', async () => {
      await selectOllamaMode(r.value);
    });
  });

  // Botão "Testar Conexão"
  document.getElementById('test-ollama-btn').addEventListener('click', testOllamaConnectionUI);

  // Botão "Salvar URL"
  document.getElementById('save-ollama-url-btn').addEventListener('click', async () => {
    const url = urlInput.value.trim() || 'http://localhost:11434';
    await sendMsg({ type: 'SAVE_SETTINGS', settings: { ollamaBaseUrl: url } });
    await refreshSettings();
    flash('URL salva!', 'ok');
  });

  // Botão "Detectar Instalados"
  document.getElementById('detect-ollama-models-btn').addEventListener('click', detectOllamaModels);

  // Event delegation for Ollama model radio buttons (dynamically rendered)
  document.getElementById('ollama-models-list').addEventListener('change', (e) => {
    if (e.target.name === 'ollama-model-radio') selectOllamaModel(e.target.value);
  });

  // Tutorial toggle (static HTML, replaced onclick with id)
  document.getElementById('tutorial-toggle-header').addEventListener('click', toggleTutorial);

  // All [data-cmd] copy buttons (both static HTML and dynamic content)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (btn) copyCmd(btn.dataset.cmd);
  });

  // Renderizar modelos instalados em cache (se houver)
  if (s.ollamaInstalledModels?.length) {
    renderOllamaModels(s.ollamaInstalledModels);
  }
}

async function selectOllamaMode(mode) {
  await sendMsg({ type: 'SAVE_SETTINGS', settings: { provider: mode } });
  await refreshSettings();
  updateProviderCards(mode);
  flash(`Modo: ${mode === 'gemini' ? 'Somente Gemini' : mode === 'ollama' ? 'Somente Ollama' : 'Híbrido'}`, 'ok');
}

function updateProviderCards(provider) {
  document.querySelectorAll('.provider-option').forEach(el => el.classList.remove('selected'));
  const active = document.querySelector(`label.provider-option:has(input[value="${provider}"])`);
  if (active) active.classList.add('selected');

  // Mostrar cards de config Ollama quando Ollama ou Híbrido estiver ativo
  const show = provider === 'ollama' || provider === 'hybrid';
  const configCard  = document.getElementById('ollama-config-card');
  const modelsCard  = document.getElementById('ollama-models-card');
  if (configCard)  configCard.style.display = show ? '' : 'none';
  if (modelsCard)  modelsCard.style.display = show ? '' : 'none';
}

async function testOllamaConnectionUI() {
  const btn    = document.getElementById('test-ollama-btn');
  const badge  = document.getElementById('ollama-status-badge');
  const infoEl = document.getElementById('ollama-connection-info');
  const errEl  = document.getElementById('ollama-connection-error');
  const infoTxt = document.getElementById('ollama-info-text');
  const errTxt  = document.getElementById('ollama-error-text');

  const baseUrl = document.getElementById('ollama-url').value.trim() || 'http://localhost:11434';

  btn.disabled = true;
  btn.textContent = 'Testando...';
  badge.innerHTML = '<span class="badge badge-testing dots">Verificando</span>';
  infoEl.style.display = 'none';
  errEl.style.display  = 'none';

  const r = await sendMsg({ type: 'TEST_OLLAMA', baseUrl });

  btn.disabled = false;
  btn.textContent = 'Testar Conexão';

  const corsHint = document.getElementById('ollama-cors-hint');

  if (r?.success) {
    badge.innerHTML = '<span class="badge badge-ok">● Conectado</span>';
    infoTxt.textContent = `Ollama conectado · ${r.count || 0} modelo(s) instalado(s)`;
    infoEl.style.display = 'flex';
    errEl.style.display  = 'none';
    if (corsHint) corsHint.style.display = 'none';

    // Cachear modelos retornados
    if (r.models?.length) {
      const formatted = r.models.map(m => ({ id: m, name: m, size: '', family: '' }));
      renderOllamaModels(formatted);
      await sendMsg({ type: 'SAVE_SETTINGS', settings: { ollamaInstalledModels: formatted } });
    }
  } else {
    badge.innerHTML = '<span class="badge badge-error">● Offline</span>';
    errTxt.textContent = r?.error || 'Ollama não encontrado em ' + baseUrl;
    infoEl.style.display = 'none';
    errEl.style.display  = 'flex';
    // Mostrar dica de CORS se o erro for 403
    if (corsHint) corsHint.style.display = (r?.error || '').includes('403') ? 'flex' : 'none';
  }
}

async function detectOllamaModels() {
  const btn     = document.getElementById('detect-ollama-models-btn');
  const baseUrl = document.getElementById('ollama-url').value.trim() || 'http://localhost:11434';

  btn.disabled = true;
  btn.textContent = '🔍 Detectando...';

  const r = await sendMsg({ type: 'GET_OLLAMA_MODELS', baseUrl });

  btn.disabled = false;
  btn.textContent = '🔍 Detectar Instalados';

  if (r?.success && r.models?.length) {
    renderOllamaModels(r.models);
    await sendMsg({ type: 'SAVE_SETTINGS', settings: { ollamaInstalledModels: r.models } });
    await refreshSettings();
    flash(`${r.models.length} modelo(s) encontrado(s)!`, 'ok');
  } else {
    document.getElementById('ollama-models-list').innerHTML =
      '<div class="empty-state" style="padding:24px"><p>Nenhum modelo encontrado. Verifique se o Ollama está rodando.</p></div>';
    flash('Nenhum modelo encontrado', 'err');
  }
}

function renderOllamaModels(models) {
  const wrap   = document.getElementById('ollama-models-list');
  const s      = currentSettings;
  const current = s.ollamaModel || 'qwen2.5:7b';

  if (!models.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px"><p>Nenhum modelo instalado.</p></div>';
    return;
  }

  const rows = models.map(m => {
    const checked = m.id === current ? 'checked' : '';
    return `<tr>
      <td style="width:36px;text-align:center">
        <input type="radio" class="radio-btn" name="ollama-model-radio" value="${esc(m.id)}" ${checked}/>
      </td>
      <td style="font-family:monospace;color:#4338ca">${esc(m.name || m.id)}</td>
      <td>${esc(m.size || '')}</td>
      <td style="color:var(--muted);font-size:12px">${esc(m.family || '')}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="models-table">
    <thead><tr><th></th><th>Modelo</th><th>Tamanho</th><th>Família</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  // Atualizar texto do modelo atual
  const chosen = models.find(m => m.id === current) || models[0];
  if (chosen) {
    document.getElementById('ollama-current-model-text').textContent =
      'Modelo ativo: ' + (chosen.name || chosen.id);
  }
}

async function selectOllamaModel(id) {
  await sendMsg({ type: 'SAVE_SETTINGS', settings: { ollamaModel: id } });
  await refreshSettings();
  document.getElementById('ollama-current-model-text').textContent = 'Modelo ativo: ' + id;
  flash('Modelo Ollama selecionado: ' + id, 'ok');
}

function copyCmd(cmd) {
  navigator.clipboard.writeText(cmd).then(
    () => flash('Copiado!', 'ok'),
    () => flash('Falha ao copiar', 'err')
  );
}

function toggleTutorial() {
  const body = document.getElementById('ollama-tutorial');
  const icon = document.getElementById('tutorial-toggle-icon');
  const open = body.style.display === 'none' || !body.style.display;
  body.style.display = open ? '' : 'none';
  if (icon) icon.textContent = open ? '▲' : '▼';
}

// ─── Preferences ─────────────────────────────────────────────────────────────

function setupPrefs() {
  document.getElementById('max-turns').value = currentSettings.maxTurns || 50;
  document.getElementById('save-prefs-btn').addEventListener('click', async () => {
    const maxTurns = parseInt(document.getElementById('max-turns').value, 10) || 50;
    await sendMsg({ type: 'SAVE_SETTINGS', settings: { maxTurns } });
    await refreshSettings();
    flash('Preferências salvas!', 'ok');
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function refreshSettings() {
  currentSettings = (await sendMsg({ type: 'GET_SETTINGS' }))?.settings || currentSettings;
}

function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(r);
    });
  });
}

let flashTimer = null;
function flash(text, type) {
  const el = document.getElementById('flash');
  el.textContent = text;
  el.className   = `show ${type}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.className = '', 3000);
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }


init().catch(console.error);

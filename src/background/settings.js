/**
 * Agente Delta - Settings Manager
 *
 * Suporta até 10 chaves API com rotação automática por fallback.
 * Formato das chaves: [{ id, key, name, active, addedAt }]
 */

const STORAGE_KEY = 'agente_delta_settings';
export const MAX_KEYS = 10;

// Ordem padrão de fallback de modelos Gemini (do mais novo ao mais estável)
export const DEFAULT_MODEL_FALLBACK = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b',
];

// Modelos Ollama recomendados para browser automation
export const DEFAULT_OLLAMA_MODEL_FALLBACK = [
  'qwen2.5:7b',
  'llama3.2-vision:11b',
  'llama3.1:8b',
  'qwen2.5:3b',
];

const DEFAULT_SETTINGS = {
  // ── Gemini (cloud) ──
  apiKeys: [],
  currentKeyIndex: 0,
  model: 'gemini-2.5-flash',
  modelFallbackEnabled: true,
  modelFallbackList: DEFAULT_MODEL_FALLBACK,

  // ── Seleção de provider ──
  // 'gemini'  → apenas Gemini (padrão)
  // 'ollama'  → apenas Ollama local
  // 'hybrid'  → Gemini primário + Ollama como fallback quando Gemini esgota
  provider: 'gemini',

  // ── Ollama (local) ──
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  ollamaModelFallbackList: DEFAULT_OLLAMA_MODEL_FALLBACK,
  ollamaInstalledModels: [],         // cache da última consulta

  maxTurns: 50,
};

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const saved  = result[STORAGE_KEY] || {};

  // Migrar formato antigo (string única → array)
  if (saved.apiKey && !saved.apiKeys) {
    saved.apiKeys = [{
      id: 1, key: saved.apiKey,
      name: 'Chave 1', active: true,
      addedAt: Date.now(),
    }];
    delete saved.apiKey;
  }

  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const merged  = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return merged;
}

/** Retorna apenas as chaves ativas */
export async function getActiveKeys() {
  const s = await getSettings();
  return (s.apiKeys || []).filter(k => k.active);
}

/**
 * Retorna a chave atual baseada no currentKeyIndex.
 * Se não houver chaves, retorna null.
 */
export async function getCurrentKey() {
  const s    = await getSettings();
  const keys = (s.apiKeys || []).filter(k => k.active);
  if (!keys.length) return null;
  const idx = (s.currentKeyIndex || 0) % keys.length;
  return keys[idx];
}

/**
 * Avança para a próxima chave ativa (chamado após 429).
 * Retorna a nova chave ou null se não houver mais.
 */
export async function rotateToNextKey() {
  const s    = await getSettings();
  const keys = (s.apiKeys || []).filter(k => k.active);
  if (keys.length <= 1) return null;

  const nextIdx = ((s.currentKeyIndex || 0) + 1) % keys.length;
  await saveSettings({ currentKeyIndex: nextIdx });
  return keys[nextIdx];
}

/** Adiciona uma nova chave */
export async function addKey(key, name) {
  const s = await getSettings();
  const keys = s.apiKeys || [];

  if (keys.length >= MAX_KEYS) throw new Error(`Limite de ${MAX_KEYS} chaves atingido.`);
  if (keys.some(k => k.key === key)) throw new Error('Esta chave já está cadastrada.');

  const newKey = {
    id:       Date.now(),
    key:      key.trim(),
    name:     name || `Chave ${keys.length + 1}`,
    active:   true,
    addedAt:  Date.now(),
  };

  await saveSettings({ apiKeys: [...keys, newKey] });
  return newKey;
}

/** Remove uma chave pelo id */
export async function removeKey(id) {
  const s    = await getSettings();
  const keys = (s.apiKeys || []).filter(k => k.id !== id);
  await saveSettings({ apiKeys: keys, currentKeyIndex: 0 });
}

/** Ativa/desativa uma chave */
export async function toggleKey(id) {
  const s    = await getSettings();
  const keys = (s.apiKeys || []).map(k =>
    k.id === id ? { ...k, active: !k.active } : k
  );
  await saveSettings({ apiKeys: keys });
}

/** Renomeia uma chave */
export async function renameKey(id, name) {
  const s    = await getSettings();
  const keys = (s.apiKeys || []).map(k =>
    k.id === id ? { ...k, name } : k
  );
  await saveSettings({ apiKeys: keys });
}

const SETTINGS_KEY = "settings";
const RECENT_WORDS_KEY = "recent_words";

function isMacPlatform() {
  try {
    return /Mac/i.test(navigator.platform || "");
  } catch {
    return false;
  }
}

const DEFAULT_HOTKEY = isMacPlatform()
  ? { code: "KeyE", ctrl: false, meta: true, alt: false, shift: false }
  : { code: "KeyS", ctrl: true, meta: false, alt: false, shift: true };

export const DEFAULT_SETTINGS = {
  subtitleBandOnly: true,
  subtitleBandTopRatio: 0.65,
  subtitleBandBottomRatio: 1.0,
  fixedSubtitleLayout: true,
  subtitleSplitRatio: 0.5,
  autoPauseOnCapture: true,
  maxRecentWords: 50,
  hotkey: DEFAULT_HOTKEY
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const top = Number(merged.subtitleBandTopRatio);
  const bottom = Number(merged.subtitleBandBottomRatio);
  const split = Number(merged.subtitleSplitRatio);
  const inputHotkey = merged.hotkey || {};
  const code = String(inputHotkey.code || DEFAULT_HOTKEY.code);
  const normalizedCode = /^(Key[A-Z]|Digit[0-9])$/.test(code) ? code : DEFAULT_HOTKEY.code;
  return {
    subtitleBandOnly: Boolean(merged.subtitleBandOnly),
    subtitleBandTopRatio: clamp(Number.isFinite(top) ? top : DEFAULT_SETTINGS.subtitleBandTopRatio, 0, 1),
    subtitleBandBottomRatio: clamp(
      Number.isFinite(bottom) ? bottom : DEFAULT_SETTINGS.subtitleBandBottomRatio,
      0,
      1
    ),
    fixedSubtitleLayout: Boolean(merged.fixedSubtitleLayout),
    subtitleSplitRatio: clamp(
      Number.isFinite(split) ? split : DEFAULT_SETTINGS.subtitleSplitRatio,
      0.2,
      0.8
    ),
    autoPauseOnCapture: Boolean(merged.autoPauseOnCapture),
    maxRecentWords: clamp(Number(merged.maxRecentWords) || DEFAULT_SETTINGS.maxRecentWords, 10, 200),
    hotkey: {
      code: normalizedCode,
      ctrl: Boolean(inputHotkey.ctrl),
      meta: Boolean(inputHotkey.meta),
      alt: Boolean(inputHotkey.alt),
      shift: Boolean(inputHotkey.shift)
    }
  };
}

export async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY]);
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...(partial || {}) });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getRecentWords() {
  const data = await chrome.storage.local.get(RECENT_WORDS_KEY);
  const words = data[RECENT_WORDS_KEY];
  return Array.isArray(words) ? words : [];
}

export async function addRecentWords(words, maxCount = DEFAULT_SETTINGS.maxRecentWords) {
  const current = await getRecentWords();
  const normalized = (Array.isArray(words) ? words : [])
    .filter(Boolean)
    .map((word) => ({
      id: word.id || crypto.randomUUID(),
      surface: word.surface || "",
      dictionary_form: word.dictionary_form || word.surface || "",
      reading: word.reading || "",
      jlpt_level: word.jlpt_level || "",
      source: word.source || "manual",
      vocab_item_id: word.vocab_item_id || null,
      meanings: Array.isArray(word.meanings) ? word.meanings : [],
      example_ja: word.example_ja || "",
      example_zh: word.example_zh || "",
      playback: word.playback || null,
      created_at: word.created_at || new Date().toISOString()
    }))
    .filter((word) => word.surface);

  const merged = [...normalized, ...current].slice(0, maxCount);
  await chrome.storage.local.set({ [RECENT_WORDS_KEY]: merged });
  return merged;
}

export async function removeRecentWordByVocabItemId(vocabItemId) {
  const current = await getRecentWords();
  const target = Number(vocabItemId || 0);
  const next = current.filter((word) => Number(word.vocab_item_id || 0) !== target);
  await chrome.storage.local.set({ [RECENT_WORDS_KEY]: next });
  return next;
}

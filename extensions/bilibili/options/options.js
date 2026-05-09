import { getSettings, updateSettings } from "../src/storage.js";

const els = {
  subtitleBandOnly: document.getElementById("subtitleBandOnly"),
  subtitleBandTopRatio: document.getElementById("subtitleBandTopRatio"),
  subtitleBandBottomRatio: document.getElementById("subtitleBandBottomRatio"),
  fixedSubtitleLayout: document.getElementById("fixedSubtitleLayout"),
  subtitleSplitRatio: document.getElementById("subtitleSplitRatio"),
  autoPauseOnCapture: document.getElementById("autoPauseOnCapture"),
  maxRecentWords: document.getElementById("maxRecentWords"),
  hotkeyCtrl: document.getElementById("hotkeyCtrl"),
  hotkeyMeta: document.getElementById("hotkeyMeta"),
  hotkeyShift: document.getElementById("hotkeyShift"),
  hotkeyAlt: document.getElementById("hotkeyAlt"),
  hotkeyKey: document.getElementById("hotkeyKey"),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status")
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setStatus(text) {
  els.status.textContent = text || "";
}

function renderSettings(settings) {
  els.subtitleBandOnly.checked = settings.subtitleBandOnly;
  els.subtitleBandTopRatio.value = settings.subtitleBandTopRatio;
  els.subtitleBandBottomRatio.value = settings.subtitleBandBottomRatio;
  els.fixedSubtitleLayout.checked = settings.fixedSubtitleLayout;
  els.subtitleSplitRatio.value = settings.subtitleSplitRatio;
  els.autoPauseOnCapture.checked = settings.autoPauseOnCapture;
  els.maxRecentWords.value = settings.maxRecentWords;
  const hk = settings.hotkey || {};
  els.hotkeyCtrl.checked = Boolean(hk.ctrl);
  els.hotkeyMeta.checked = Boolean(hk.meta);
  els.hotkeyShift.checked = Boolean(hk.shift);
  els.hotkeyAlt.checked = Boolean(hk.alt);
  const key = String(hk.code || "KeyS").replace(/^Key/, "").replace(/^Digit/, "");
  els.hotkeyKey.value = key;
}

function toHotkeyCode(keyValue) {
  const key = String(keyValue || "")
    .trim()
    .toUpperCase();
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return "KeyS";
}

function collectSettingsFromForm() {
  const top = clamp(Number(els.subtitleBandTopRatio.value), 0, 1);
  const bottom = clamp(Number(els.subtitleBandBottomRatio.value), 0, 1);
  const split = clamp(Number(els.subtitleSplitRatio.value), 0.2, 0.8);
  return {
    subtitleBandOnly: els.subtitleBandOnly.checked,
    subtitleBandTopRatio: top,
    subtitleBandBottomRatio: Math.max(top, bottom),
    fixedSubtitleLayout: els.fixedSubtitleLayout.checked,
    subtitleSplitRatio: split,
    autoPauseOnCapture: els.autoPauseOnCapture.checked,
    maxRecentWords: clamp(Math.round(Number(els.maxRecentWords.value) || 50), 10, 200),
    hotkey: {
      code: toHotkeyCode(els.hotkeyKey.value),
      ctrl: els.hotkeyCtrl.checked,
      meta: els.hotkeyMeta.checked,
      shift: els.hotkeyShift.checked,
      alt: els.hotkeyAlt.checked
    }
  };
}

async function init() {
  const settings = await getSettings();
  renderSettings(settings);
}

els.saveBtn.addEventListener("click", async () => {
  try {
    const saved = await updateSettings(collectSettingsFromForm());
    renderSettings(saved);
    setStatus("保存成功");
  } catch (error) {
    setStatus(`保存失败: ${String(error?.message || error)}`);
  }
});

init();

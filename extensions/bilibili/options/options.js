import { getSettings, normalizeSidecarBaseUrl, updateSettings } from "../src/storage.js";

const els = {
  sidecarBaseUrl: document.getElementById("sidecarBaseUrl"),
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

async function ensureSidecarHostPermission(originUrl) {
  try {
    const u = new URL(originUrl);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (loopback) return { ok: true, skipped: true };
    if (!chrome.permissions?.request || !chrome.permissions?.contains) {
      return { ok: true, skipped: true };
    }
    const perm = { origins: [`${u.origin}/*`] };
    const has = await chrome.permissions.contains(perm);
    if (has) return { ok: true, skipped: true };
    const granted = await chrome.permissions.request(perm);
    return {
      ok: granted,
      skipped: false,
      message: granted ? "" : "未授予插件访问该地址的权限，请求可能被浏览器拦截。"
    };
  } catch {
    return { ok: false, skipped: false, message: "sidecar 地址格式无效。" };
  }
}

function setStatus(text) {
  els.status.textContent = text || "";
}

function renderSettings(settings) {
  els.sidecarBaseUrl.value = settings.sidecarBaseUrl || "";
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
  const split = clamp(Number(els.subtitleSplitRatio.value), 0.2, 0.9);
  return {
    sidecarBaseUrl: normalizeSidecarBaseUrl(els.sidecarBaseUrl.value),
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
    const form = collectSettingsFromForm();
    const perm = await ensureSidecarHostPermission(form.sidecarBaseUrl);
    if (!perm.ok) {
      setStatus(perm.message || "无法为该地址申请浏览器权限");
      return;
    }
    const saved = await updateSettings(form);
    renderSettings(saved);
    let msg = "保存成功";
    if (!perm.skipped && perm.message) msg += ` · ${perm.message}`;
    setStatus(msg);
  } catch (error) {
    setStatus(`保存失败: ${String(error?.message || error)}`);
  }
});

init();

const IS_MAC = /Mac/i.test(navigator.platform || "");
const DEFAULT_HOTKEY = IS_MAC
  ? { code: "KeyE", ctrl: false, meta: true, alt: false, shift: false }
  : { code: "KeyS", ctrl: true, meta: false, alt: false, shift: true };
const FALLBACK_HOTKEYS = IS_MAC
  ? [
      { code: "KeyE", ctrl: false, meta: true, alt: false, shift: false },
      { code: "KeyS", ctrl: false, meta: true, alt: false, shift: true }
    ]
  : [{ code: "KeyS", ctrl: true, meta: false, alt: false, shift: true }];

let activeHotkey = { ...DEFAULT_HOTKEY };
const STATUS_BADGE_ID = "wordbook-capture-status-badge";

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName ? target.tagName.toLowerCase() : "";
  return (
    tag === "input" ||
    tag === "textarea" ||
    target.isContentEditable === true
  );
}

function normalizeHotkey(input) {
  const raw = input || {};
  const code = String(raw.code || DEFAULT_HOTKEY.code);
  return {
    code: /^(Key[A-Z]|Digit[0-9])$/.test(code) ? code : DEFAULT_HOTKEY.code,
    ctrl: Boolean(raw.ctrl),
    meta: Boolean(raw.meta),
    alt: Boolean(raw.alt),
    shift: Boolean(raw.shift)
  };
}

async function loadHotkey() {
  const data = await chrome.storage.local.get("settings");
  activeHotkey = normalizeHotkey(data?.settings?.hotkey);
}

function matchHotkey(event, hotkey) {
  // Required modifiers must be present; extra modifiers are tolerated
  // to reduce platform-specific shortcut mismatch issues.
  if (hotkey.ctrl && !event.ctrlKey) return false;
  if (hotkey.meta && !event.metaKey) return false;
  if (hotkey.alt && !event.altKey) return false;
  if (hotkey.shift && !event.shiftKey) return false;
  return (
    event.code === hotkey.code
  );
}

function matchAnyFallback(event) {
  return FALLBACK_HOTKEYS.some((hotkey) => {
    if (hotkey.ctrl !== Boolean(event.ctrlKey)) return false;
    if (hotkey.meta !== Boolean(event.metaKey)) return false;
    if (hotkey.alt !== Boolean(event.altKey)) return false;
    if (hotkey.shift !== Boolean(event.shiftKey)) return false;
    return event.code === hotkey.code;
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes.settings) return;
  activeHotkey = normalizeHotkey(changes.settings.newValue?.hotkey);
});

loadHotkey();

function ensureStatusBadge() {
  let badge = document.getElementById(STATUS_BADGE_ID);
  if (badge) return badge;
  badge = document.createElement("div");
  badge.id = STATUS_BADGE_ID;
  Object.assign(badge.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483646",
    background: "rgba(17,24,39,0.85)",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "999px",
    fontSize: "12px",
    lineHeight: "16px",
    pointerEvents: "none",
    transition: "opacity 0.2s ease",
    opacity: "0.88"
  });
  badge.textContent = "Wordbook：空闲";
  document.documentElement.appendChild(badge);
  return badge;
}

function setStatusBadge(status, message) {
  const badge = ensureStatusBadge();
  const statusText =
    status === "processing" ? "处理中" : status === "error" ? "错误" : "空闲";
  badge.textContent = `Wordbook：${statusText}${message ? ` · ${message}` : ""}`;
  if (status === "error") {
    badge.style.background = "rgba(185,28,28,0.9)";
  } else if (status === "processing") {
    badge.style.background = "rgba(29,78,216,0.9)";
  } else {
    badge.style.background = "rgba(17,24,39,0.85)";
  }
}

ensureStatusBadge();

document.addEventListener(
  "keydown",
  (event) => {
    if (event.repeat) return;
    if (isEditableTarget(event.target)) return;
    if (!matchHotkey(event, activeHotkey) && !matchAnyFallback(event)) return;
    event.preventDefault();

    chrome.runtime.sendMessage({
      type: "POC_CAPTURE_PIPELINE",
      source: "content_hotkey"
    });
  },
  true
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "POC_STATUS_UPDATE") {
    setStatusBadge(message.status, message.message || "");
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

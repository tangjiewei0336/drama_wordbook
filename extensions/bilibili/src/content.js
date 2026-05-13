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
const AUTO_WORD_FEED_ID = "wordbook-auto-word-feed";
const AUTO_WORD_FEED_LIST_ID = "wordbook-auto-word-feed-list";
const AUTO_WORD_FEED_DEDUPE_MS = 30000;
let asrRecorder = null;
let asrMediaStream = null;
let asrAudioContext = null;
let asrAnalyser = null;
let asrLevelTimer = null;
let asrVideo = null;
let asrCaptureId = 0;
let asrSendChunks = false;
const autoWordFeedRecent = new Map();

function getOverlayHost() {
  const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (fullscreen) {
    return fullscreen.tagName?.toLowerCase() === "video" ? fullscreen.parentElement || document.documentElement : fullscreen;
  }
  const selectors = [
    ".bpx-player-container[data-screen='full']",
    ".bpx-player-container[data-screen='web']",
    ".bpx-player-container.bpx-state-fullscreen",
    ".bpx-player-container.bpx-state-web-fullscreen",
    ".bpx-player-container.mode-fullscreen",
    ".bpx-player-container.mode-webscreen",
    ".bilibili-player-video-wrap[style*='position: fixed']"
  ];
  return selectors.map((selector) => document.querySelector(selector)).find(Boolean) || document.documentElement;
}

function notifyAsrStopped(reason) {
  chrome.runtime.sendMessage({
    type: "POC_ASR_STOPPED_BY_VIDEO",
    reason
  }).catch(() => {});
}

function removeAsrVideoListeners() {
  if (!asrVideo) return;
  asrVideo.removeEventListener("pause", handleAsrVideoPaused);
  asrVideo.removeEventListener("ended", handleAsrVideoEnded);
  asrVideo.removeEventListener("emptied", handleAsrVideoEmptied);
  asrVideo = null;
}

function handleAsrVideoPaused() {
  stopAsrCapture("video_paused");
  notifyAsrStopped("video_paused");
}

function handleAsrVideoEnded() {
  stopAsrCapture("video_ended");
  notifyAsrStopped("video_ended");
}

function handleAsrVideoEmptied() {
  stopAsrCapture("video_unloaded");
  notifyAsrStopped("video_unloaded");
}

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
  if (badge) {
    const host = getOverlayHost();
    if (badge.parentElement !== host) host.appendChild(badge);
    return badge;
  }
  badge = document.createElement("div");
  badge.id = STATUS_BADGE_ID;
  Object.assign(badge.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483646",
    background: "rgba(17,24,39,0.62)",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "999px",
    fontSize: "12px",
    lineHeight: "16px",
    pointerEvents: "none",
    transition: "opacity 0.2s ease",
    opacity: "0.78"
  });
  badge.textContent = "UNI：空闲";
  getOverlayHost().appendChild(badge);
  return badge;
}

function setStatusBadge(status, message) {
  const badge = ensureStatusBadge();
  const statusText =
    status === "processing" ? "处理中" : status === "error" ? "错误" : "空闲";
  badge.textContent = `UNI：${statusText}${message ? ` · ${message}` : ""}`;
  if (status === "error") {
    badge.style.background = "rgba(185,28,28,0.74)";
  } else if (status === "processing") {
    badge.style.background = "rgba(29,78,216,0.72)";
  } else {
    badge.style.background = "rgba(17,24,39,0.62)";
  }
}

ensureStatusBadge();

function ensureAutoWordFeed() {
  let feed = document.getElementById(AUTO_WORD_FEED_ID);
  if (feed) {
    const host = getOverlayHost();
    if (feed.parentElement !== host) host.appendChild(feed);
    return feed;
  }
  feed = document.createElement("div");
  feed.id = AUTO_WORD_FEED_ID;
  Object.assign(feed.style, {
    position: "fixed",
    left: "14px",
    top: "14px",
    zIndex: "2147483645",
    width: "280px",
    maxHeight: "260px",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: "10px",
    background: "rgba(17,24,39,0.54)",
    color: "#fff",
    boxShadow: "0 18px 48px rgba(0,0,0,0.18)",
    backdropFilter: "blur(10px)",
    opacity: "0",
    transform: "translateY(-6px)",
    transition: "opacity 0.18s ease, transform 0.18s ease",
    pointerEvents: "none"
  });
  const title = document.createElement("div");
  title.textContent = "自动发现生词";
  Object.assign(title.style, {
    padding: "10px 12px 6px",
    fontSize: "12px",
    fontWeight: "800",
    color: "rgba(255,255,255,0.74)"
  });
  const list = document.createElement("div");
  list.id = AUTO_WORD_FEED_LIST_ID;
  Object.assign(list.style, {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: "206px",
    overflow: "hidden",
    padding: "0 10px 10px"
  });
  feed.appendChild(title);
  feed.appendChild(list);
  getOverlayHost().appendChild(feed);
  return feed;
}

function showAutoWordFeed(words) {
  const feed = ensureAutoWordFeed();
  const list = feed.querySelector(`#${AUTO_WORD_FEED_LIST_ID}`);
  const incoming = Array.isArray(words) ? words : [];
  const now = Date.now();
  if (!incoming.length) {
    feed.style.opacity = "1";
    feed.style.transform = "translateY(0)";
    return;
  }
  incoming.slice(0, 8).forEach((word) => {
    const surfaceText = word?.surface || "";
    const wordKey = `${word?.dictionary_form || surfaceText}:${word?.jlpt_level || ""}`;
    const lastShownAt = autoWordFeedRecent.get(wordKey) || 0;
    if (now - lastShownAt < AUTO_WORD_FEED_DEDUPE_MS) {
      return;
    }
    autoWordFeedRecent.set(wordKey, now);
    const item = document.createElement("div");
    item.dataset.wordKey = wordKey;
    item.title = [
      surfaceText,
      word?.dictionary_form ? `原型: ${word.dictionary_form}` : "",
      word?.reading ? `读音: ${word.reading}` : "",
      word?.jlpt_level || ""
    ].filter(Boolean).join(" · ");
    Object.assign(item.style, {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) auto",
      gap: "3px 8px",
      alignItems: "center",
      padding: "7px 8px",
      borderRadius: "8px",
      background: "rgba(255,255,255,0.16)",
      fontSize: "13px"
    });
    const surface = document.createElement("span");
    surface.textContent = surfaceText;
    Object.assign(surface.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontWeight: "800"
    });
    const rightTools = document.createElement("span");
    Object.assign(rightTools.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "5px"
    });
    const level = document.createElement("span");
    level.textContent = word?.jlpt_level || "";
    Object.assign(level.style, {
      padding: "2px 6px",
      borderRadius: "999px",
      color: "#dcfce7",
      background: "rgba(46,143,118,0.42)",
      fontSize: "11px",
      fontWeight: "900"
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.title = "删除数据库词条";
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 8h10l-1 13H8L7 8Z"/></svg>';
    Object.assign(deleteBtn.style, {
      width: "20px",
      height: "20px",
      display: word?.vocab_item_id ? "inline-grid" : "none",
      placeItems: "center",
      border: "0",
      borderRadius: "999px",
      color: "#fecaca",
      background: "rgba(185,28,28,0.34)",
      padding: "0",
      cursor: "pointer",
      pointerEvents: "auto"
    });
    const svg = deleteBtn.querySelector("svg");
    if (svg) {
      Object.assign(svg.style, {
        width: "13px",
        height: "13px",
        fill: "currentColor"
      });
    }
    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteBtn.disabled = true;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "POC_DELETE_VOCAB_ITEM",
          vocab_item_id: word.vocab_item_id
        });
        if (res?.ok) {
          item.remove();
        } else {
          deleteBtn.disabled = false;
        }
      } catch {
        deleteBtn.disabled = false;
      }
    });
    item.appendChild(surface);
    if (level.textContent) rightTools.appendChild(level);
    rightTools.appendChild(deleteBtn);
    item.appendChild(rightTools);
    const meaning = document.createElement("span");
    const formText = word?.dictionary_form && word.dictionary_form !== surfaceText ? `原型: ${word.dictionary_form}` : "";
    const readingText = word?.reading ? `读音: ${word.reading}` : "";
    const meaningText = Array.isArray(word?.meanings) && word.meanings.length ? word.meanings[0] : word?.dictionary_form || "";
    meaning.textContent = [formText, readingText, meaningText].filter(Boolean).join(" · ");
    Object.assign(meaning.style, {
      gridColumn: "1 / 3",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "rgba(255,255,255,0.72)",
      fontSize: "11px",
      lineHeight: "14px"
    });
    item.appendChild(meaning);
    list.prepend(item);
  });
  for (const [key, shownAt] of autoWordFeedRecent.entries()) {
    if (now - shownAt > AUTO_WORD_FEED_DEDUPE_MS * 4) {
      autoWordFeedRecent.delete(key);
    }
  }
  while (list.children.length > 12) list.lastElementChild.remove();
  feed.style.opacity = "1";
  feed.style.transform = "translateY(0)";
}

function hideAutoWordFeed() {
  const feed = document.getElementById(AUTO_WORD_FEED_ID);
  if (!feed) return;
  feed.style.opacity = "0";
  feed.style.transform = "translateY(-6px)";
}

function rehomeFloatingWidgets() {
  const host = getOverlayHost();
  [STATUS_BADGE_ID, AUTO_WORD_FEED_ID].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.parentElement !== host) host.appendChild(el);
  });
}

document.addEventListener("fullscreenchange", rehomeFloatingWidgets);
document.addEventListener("webkitfullscreenchange", rehomeFloatingWidgets);

async function blobToBase64(blob) {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function startAsrCapture(intervalMs = 15000) {
  if (asrRecorder && asrRecorder.state !== "inactive") {
    return { ok: true, message: "already running" };
  }
  const video = document.querySelector("video");
  if (!video || !video.captureStream) {
    return { ok: false, error: "当前页面不支持音频采集" };
  }
  if (video.paused || video.ended) {
    return { ok: false, error: "请先播放视频，再启动语音识别" };
  }
  const stream = video.captureStream();
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    return { ok: false, error: "未检测到音频轨道" };
  }
  const captureId = asrCaptureId + 1;
  asrCaptureId = captureId;
  asrSendChunks = true;
  asrVideo = video;
  asrVideo.addEventListener("pause", handleAsrVideoPaused);
  asrVideo.addEventListener("ended", handleAsrVideoEnded);
  asrVideo.addEventListener("emptied", handleAsrVideoEmptied);
  asrMediaStream = new MediaStream([audioTracks[0]]);
  asrAudioContext = new AudioContext();
  const sourceNode = asrAudioContext.createMediaStreamSource(asrMediaStream);
  asrAnalyser = asrAudioContext.createAnalyser();
  asrAnalyser.fftSize = 1024;
  sourceNode.connect(asrAnalyser);
  const levelArray = new Uint8Array(asrAnalyser.fftSize);
  asrLevelTimer = window.setInterval(() => {
    try {
      if (!asrAnalyser) return;
      asrAnalyser.getByteTimeDomainData(levelArray);
      let sum = 0;
      for (let i = 0; i < levelArray.length; i += 1) {
        const centered = (levelArray[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / levelArray.length);
      const level = Math.max(0, Math.min(1, rms * 3));
      chrome.runtime.sendMessage({
        type: "POC_ASR_LEVEL",
        level,
        rms
      });
    } catch {
      // ignore level sampling errors
    }
  }, 300);

  const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  asrRecorder = new MediaRecorder(asrMediaStream, { mimeType: preferred });
  asrRecorder.ondataavailable = async (event) => {
    try {
      if (captureId !== asrCaptureId || !asrSendChunks) return;
      if (!asrVideo || asrVideo.paused || asrVideo.ended) return;
      if (!event.data || event.data.size < 1024) return;
      const audioBase64 = await blobToBase64(event.data);
      if (captureId !== asrCaptureId || !asrSendChunks) return;
      await chrome.runtime.sendMessage({
        type: "POC_ASR_AUDIO_CHUNK",
        audio_base64: audioBase64,
        mime_type: event.data.type || preferred
      });
    } catch (_error) {
      // ignore chunk failure
    }
  };
  asrRecorder.start(intervalMs);
  return { ok: true };
}

function stopAsrCapture(_reason = "manual") {
  asrSendChunks = false;
  asrCaptureId += 1;
  try {
    if (asrRecorder && asrRecorder.state !== "inactive") {
      asrRecorder.stop();
    }
  } catch {}
  asrRecorder = null;
  if (asrLevelTimer) {
    window.clearInterval(asrLevelTimer);
  }
  asrLevelTimer = null;
  if (asrAudioContext) {
    asrAudioContext.close().catch(() => {});
  }
  asrAudioContext = null;
  asrAnalyser = null;
  removeAsrVideoListeners();
  if (asrMediaStream) {
    asrMediaStream.getTracks().forEach((t) => t.stop());
  }
  asrMediaStream = null;
}

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
  if (message?.type === "POC_AUTO_WORDS_UPDATE") {
    showAutoWordFeed(message.words || []);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "POC_AUTO_WORDS_CLEAR") {
    hideAutoWordFeed();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "POC_ASR_CONTROL") {
    if (message.action === "start") {
      startAsrCapture(Number(message.interval_ms || 60000)).then(sendResponse);
      return true;
    }
    if (message.action === "stop") {
      stopAsrCapture();
      sendResponse({ ok: true });
      return true;
    }
  }
  return false;
});

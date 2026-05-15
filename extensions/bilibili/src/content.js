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
/** When set, periodically calls MediaRecorder.requestData() (avoids Chromium timeslice + captureStream stopping after one slice). */
let asrSliceTimer = null;
/** If no chunk reaches the extension background for too long, restart capture. */
let asrWatchdogTimer = null;
/** Last time background accepted a POC_ASR_AUDIO_CHUNK (0 = none yet this session). */
let asrLastChunkAcceptedAt = 0;
let asrSessionStartedAt = 0;
let asrRestartCooldownUntil = 0;
let asrVideo = null;
let asrCaptureId = 0;
let asrSendChunks = false;
/** Matches background POC_ASR_START interval_ms (slice period for ASR chunks). */
let asrRecordingIntervalMs = 15000;
const autoWordFeedRecent = new Map();

function parseMeaningsInput(value) {
  return String(value || "")
    .split(/[\n;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function showAutoWordEditPopup(word, onSaved) {
  const existing = document.getElementById("wordbook-auto-word-edit-popup");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "wordbook-auto-word-edit-popup";
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    placeItems: "center",
    padding: "18px",
    background: "rgba(15,23,42,0.34)",
    pointerEvents: "auto"
  });
  const modal = document.createElement("div");
  Object.assign(modal.style, {
    width: "min(420px, calc(100vw - 36px))",
    borderRadius: "10px",
    background: "rgba(255,255,255,0.96)",
    border: "1px solid rgba(223,229,235,0.9)",
    boxShadow: "0 24px 70px rgba(15,23,42,0.22)",
    padding: "16px",
    color: "#263241",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  });
  const title = document.createElement("div");
  title.textContent = "修改自动识别词条";
  Object.assign(title.style, {
    fontSize: "15px",
    fontWeight: "900",
    marginBottom: "12px"
  });

  const makeField = (labelText, value, multiline = false) => {
    const label = document.createElement("label");
    Object.assign(label.style, {
      display: "grid",
      gap: "5px",
      marginBottom: "10px",
      fontSize: "12px",
      fontWeight: "800",
      color: "#475467"
    });
    const labelSpan = document.createElement("span");
    labelSpan.textContent = labelText;
    const input = document.createElement(multiline ? "textarea" : "input");
    input.value = value || "";
    if (multiline) input.rows = 3;
    Object.assign(input.style, {
      width: "100%",
      boxSizing: "border-box",
      border: "1px solid #d0d5dd",
      borderRadius: "8px",
      padding: "9px 10px",
      outline: "none",
      font: "inherit",
      fontSize: "13px",
      color: "#263241",
      resize: multiline ? "vertical" : "none"
    });
    label.appendChild(labelSpan);
    label.appendChild(input);
    return { label, input };
  };

  const surface = makeField("词面", word?.surface || "");
  const dictionaryForm = makeField("原形", word?.dictionary_form || word?.surface || "");
  const reading = makeField("读音", word?.reading || "");
  const jlpt = makeField("JLPT", word?.jlpt_level || "");
  const meanings = makeField("释义", Array.isArray(word?.meanings) ? word.meanings.join("；") : "", true);
  const status = document.createElement("div");
  Object.assign(status.style, {
    minHeight: "18px",
    color: "#b42318",
    fontSize: "12px",
    fontWeight: "700",
    margin: "2px 0 10px"
  });
  const actions = document.createElement("div");
  Object.assign(actions.style, {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px"
  });
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "保存";
  [cancelBtn, saveBtn].forEach((btn) => {
    Object.assign(btn.style, {
      border: "0",
      borderRadius: "8px",
      padding: "8px 12px",
      fontSize: "13px",
      fontWeight: "800",
      cursor: "pointer"
    });
  });
  Object.assign(cancelBtn.style, { background: "#eef2f6", color: "#344054" });
  Object.assign(saveBtn.style, { background: "#2e8f76", color: "#fff" });

  cancelBtn.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) backdrop.remove();
  });
  saveBtn.addEventListener("click", async () => {
    const nextSurface = surface.input.value.trim();
    if (!nextSurface) {
      status.textContent = "词面不能为空";
      return;
    }
    saveBtn.disabled = true;
    status.textContent = "";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "POC_UPDATE_VOCAB_ITEM",
        vocab_item_id: word?.vocab_item_id,
        surface: nextSurface,
        dictionary_form: dictionaryForm.input.value.trim() || nextSurface,
        reading: reading.input.value.trim(),
        jlpt_level: jlpt.input.value.trim(),
        meanings: parseMeaningsInput(meanings.input.value),
        example_ja: word?.example_ja || "",
        example_zh: word?.example_zh || ""
      });
      if (!res?.ok) throw new Error(res?.error || "保存失败");
      onSaved?.(res.item);
      backdrop.remove();
    } catch (error) {
      status.textContent = String(error?.message || error);
      saveBtn.disabled = false;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  modal.appendChild(title);
  [surface, dictionaryForm, reading, jlpt, meanings].forEach((field) => modal.appendChild(field.label));
  modal.appendChild(status);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  getOverlayHost().appendChild(backdrop);
  surface.input.focus();
}

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

function detachAsrVideoElementListeners(video) {
  if (!video) return;
  video.removeEventListener("pause", handleAsrVideoPaused);
  video.removeEventListener("ended", handleAsrVideoEnded);
  video.removeEventListener("emptied", handleAsrVideoEmptied);
  video.removeEventListener("play", handleAsrVideoPlay);
}

function removeAsrVideoListeners() {
  detachAsrVideoElementListeners(asrVideo);
  asrVideo = null;
}

function clearAsrSliceTimer() {
  if (asrSliceTimer != null) {
    window.clearInterval(asrSliceTimer);
    asrSliceTimer = null;
  }
}

function clearAsrWatchdog() {
  if (asrWatchdogTimer != null) {
    window.clearInterval(asrWatchdogTimer);
    asrWatchdogTimer = null;
  }
}

/** Resume MediaRecorder after a buffering pause; background asrRunning stays true. */
function handleAsrVideoPlay() {
  if (!asrVideo || asrVideo.paused || asrVideo.ended) return;
  void startAsrCapture(asrRecordingIntervalMs);
}

function handleAsrVideoPaused() {
  // Do not notify background: Bilibili often fires pause during buffering/quality
  // switches; that would set asrRunning=false and kill all subsequent chunks.
  stopAsrCapture("video_paused");
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
    status === "processing"
      ? "处理中"
      : status === "listening"
        ? "监听中"
        : status === "error"
          ? "错误"
          : "空闲";
  badge.textContent = `UNI：${statusText}${message ? ` · ${message}` : ""}`;
  if (status === "error") {
    badge.style.background = "rgba(185,28,28,0.74)";
  } else if (status === "processing") {
    badge.style.background = "rgba(29,78,216,0.72)";
  } else if (status === "listening") {
    badge.style.background = "rgba(5,118,90,0.72)";
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
    let wordState = { ...(word || {}) };
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
    Object.assign(level.style, {
      padding: "2px 6px",
      borderRadius: "999px",
      color: "#dcfce7",
      background: "rgba(46,143,118,0.42)",
      fontSize: "11px",
      fontWeight: "900"
    });
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.title = "修改词条";
    editBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.25V20h2.75L17.8 8.95l-2.75-2.75L4 17.25Zm15.9-10.4a1 1 0 0 0 0-1.42l-1.33-1.33a1 1 0 0 0-1.42 0l-1.04 1.04 2.75 2.75 1.04-1.04Z"/></svg>';
    Object.assign(editBtn.style, {
      width: "20px",
      height: "20px",
      display: word?.vocab_item_id ? "inline-grid" : "none",
      placeItems: "center",
      border: "0",
      borderRadius: "999px",
      color: "#dbeafe",
      background: "rgba(37,99,235,0.38)",
      padding: "0",
      cursor: "pointer",
      pointerEvents: "auto"
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
    const editSvg = editBtn.querySelector("svg");
    [svg, editSvg].filter(Boolean).forEach((icon) => {
      Object.assign(icon.style, {
        width: "13px",
        height: "13px",
        fill: "currentColor"
      });
    });
    const meaning = document.createElement("span");
    const renderWord = () => {
      const currentSurface = wordState?.surface || "";
      surface.textContent = currentSurface;
      level.textContent = wordState?.jlpt_level || "";
      level.style.display = level.textContent ? "inline-block" : "none";
      item.title = [
        currentSurface,
        wordState?.dictionary_form ? `原型: ${wordState.dictionary_form}` : "",
        wordState?.reading ? `读音: ${wordState.reading}` : "",
        wordState?.jlpt_level || ""
      ].filter(Boolean).join(" · ");
      const formText = wordState?.dictionary_form && wordState.dictionary_form !== currentSurface ? `原型: ${wordState.dictionary_form}` : "";
      const readingText = wordState?.reading ? `读音: ${wordState.reading}` : "";
      const meaningText = Array.isArray(wordState?.meanings) && wordState.meanings.length ? wordState.meanings[0] : wordState?.dictionary_form || "";
      meaning.textContent = [formText, readingText, meaningText].filter(Boolean).join(" · ");
    };
    editBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showAutoWordEditPopup(wordState, (updated) => {
        wordState = { ...wordState, ...(updated || {}), vocab_item_id: wordState.vocab_item_id };
        renderWord();
      });
    });
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
    rightTools.appendChild(level);
    rightTools.appendChild(editBtn);
    rightTools.appendChild(deleteBtn);
    item.appendChild(rightTools);
    Object.assign(meaning.style, {
      gridColumn: "1 / 3",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "rgba(255,255,255,0.72)",
      fontSize: "11px",
      lineHeight: "14px"
    });
    renderWord();
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
  detachAsrVideoElementListeners(asrVideo);
  detachAsrVideoElementListeners(video);
  const captureId = asrCaptureId + 1;
  asrCaptureId = captureId;
  asrSendChunks = true;
  asrSessionStartedAt = Date.now();
  asrLastChunkAcceptedAt = 0;
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
      const live = document.querySelector("video");
      if (live && live !== asrVideo && !live.paused && !live.ended) {
        stopAsrCapture("recorder_restart");
        return;
      }
      if (!asrVideo || asrVideo.paused || asrVideo.ended) return;
      if (!event.data || event.data.size < 256) return;
      const audioBase64 = await blobToBase64(event.data);
      if (captureId !== asrCaptureId || !asrSendChunks) return;
      const res = await chrome.runtime.sendMessage({
        type: "POC_ASR_AUDIO_CHUNK",
        audio_base64: audioBase64,
        mime_type: event.data.type || preferred
      });
      if (res?.skipped) {
        console.warn("[wordbook] ASR chunk rejected by background (session not running?)", res);
        return;
      }
      if (res?.ok && res?.queued) {
        asrLastChunkAcceptedAt = Date.now();
      }
    } catch (_error) {
      // ignore chunk failure
    }
  };
  // Chromium + captureStream(): recorder often ends after the first slice; restart without user toggling ASR.
  // Defer handling so an in-flight ondataavailable (async blobToBase64) can finish before captureId bumps.
  asrRecorder.onstop = () => {
    window.setTimeout(() => {
      try {
        if (captureId !== asrCaptureId || !asrSendChunks) return;
        const v = document.querySelector("video");
        if (!v || v.paused || v.ended) return;
        stopAsrCapture("recorder_restart");
      } catch (_e) {
        // ignore
      }
    }, 160);
  };

  const canRequestSlices =
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.prototype.requestData === "function";

  if (canRequestSlices) {
    clearAsrSliceTimer();
    asrRecorder.start();
    asrSliceTimer = window.setInterval(() => {
      try {
        if (captureId !== asrCaptureId || !asrSendChunks) return;
        if (!asrRecorder) return;
        if (asrRecorder.state !== "recording") {
          const v = document.querySelector("video");
          if (v && !v.paused && !v.ended) {
            stopAsrCapture("recorder_restart");
          }
          return;
        }
        asrRecorder.requestData();
      } catch {
        // ignore
      }
    }, intervalMs);
  } else {
    asrRecorder.start(intervalMs);
  }

  clearAsrWatchdog();
  asrWatchdogTimer = window.setInterval(() => {
    try {
      if (captureId !== asrCaptureId || !asrSendChunks) return;
      if (!asrVideo || asrVideo.paused || asrVideo.ended) return;
      const now = Date.now();
      if (now < asrRestartCooldownUntil) return;
      const anchor = asrLastChunkAcceptedAt > 0 ? asrLastChunkAcceptedAt : asrSessionStartedAt;
      const allowed =
        asrLastChunkAcceptedAt > 0
          ? asrRecordingIntervalMs * 2 + 12000
          : asrRecordingIntervalMs + 22000;
      if (now - anchor > allowed) {
        console.warn("[wordbook] ASR watchdog: no chunk accepted by background; restarting capture");
        asrRestartCooldownUntil = now + 4000;
        stopAsrCapture("recorder_restart");
      }
    } catch (_e) {
      // ignore
    }
  }, 4000);

  return { ok: true };
}

function stopAsrCapture(reason = "manual") {
  const resumeOnPlay = reason === "video_paused";
  const restartRecorder = reason === "recorder_restart";
  clearAsrSliceTimer();
  clearAsrWatchdog();
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
  if (asrMediaStream) {
    asrMediaStream.getTracks().forEach((t) => t.stop());
  }
  asrMediaStream = null;

  if (restartRecorder) {
    const v = document.querySelector("video");
    if (v && !v.paused && !v.ended) {
      window.setTimeout(() => {
        void startAsrCapture(asrRecordingIntervalMs);
      }, 40);
    }
    return;
  }
  if (!resumeOnPlay) {
    removeAsrVideoListeners();
    return;
  }
  if (asrVideo) {
    try {
      asrVideo.addEventListener("play", handleAsrVideoPlay, { once: true });
    } catch (_e) {
      // ignore
    }
  }
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
      asrRecordingIntervalMs = Number(message.interval_ms || 15000);
      startAsrCapture(asrRecordingIntervalMs).then(sendResponse);
      return true;
    }
    if (message.action === "stop") {
      stopAsrCapture();
      sendResponse({ ok: true });
      return true;
    }
    if (message.action === "recycle") {
      const ms = Number(message.interval_ms || 15000);
      if (!asrSendChunks) {
        sendResponse({ ok: true, skipped: true });
        return true;
      }
      stopAsrCapture("manual");
      startAsrCapture(ms).then(sendResponse);
      return true;
    }
  }
  return false;
});

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
let asrRecorder = null;
let asrMediaStream = null;
let asrAudioContext = null;
let asrAnalyser = null;
let asrLevelTimer = null;
let asrVideo = null;
let asrCaptureId = 0;
let asrSendChunks = false;

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

import { addRecentWords, getRecentWords, getSettings, removeRecentWordByVocabItemId, updateRecentWordByVocabItemId } from "./storage.js";

function shortenForUi(text, maxLen = 220) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function formatPipelineFailure(error) {
  return shortenForUi(String(error?.message || error || "未知错误"));
}

function normalizeOcrJapaneseText(text) {
  const source = String(text || "");
  const nextSmallTsuKana = "[かきくけこさしすせそたちてとぱぴぷぺぽカキクケコサシスセソタチテトパピプペポ]";
  const prevJa = "[ぁ-んァ-ン一-龯]";
  return source
    .replace(new RegExp(`(${prevJa})つ(?=${nextSmallTsuKana})`, "g"), (match, prev, offset, full) => {
      const next = full.charAt(offset + match.length);
      if (prev === "い" && next === "か") return match;
      return `${prev}っ`;
    })
    .replace(new RegExp(`(${prevJa})ツ(?=${nextSmallTsuKana})`, "g"), "$1ッ");
}

async function fetchSidecar(path, init) {
  const { sidecarBaseUrl } = await getSettings();
  const url = `${sidecarBaseUrl}${path}`;
  try {
    return await fetch(url, init);
  } catch (error) {
    const cause = error?.cause && typeof error.cause === "object" && error.cause?.message;
    const detail = cause || String(error?.message || error);
    throw new Error(
      `无法连接 Sidecar（${sidecarBaseUrl}）：${detail}。若桌面端显示已启动，请在浏览器打开 ${sidecarBaseUrl}/health 检查服务是否响应。`
    );
  }
}
let lastCaptureResult = null;
let captureLock = false;
let captureLockStartedAt = 0;
let asrRunning = false;
/** Serial drain of ASR audio chunks (MediaRecorder emits on a fixed cadence faster than Whisper). */
let asrChunkQueue = [];
let asrDrainRunning = false;
const ASR_CHUNK_QUEUE_CAP = 12;
let recentAsrResults = [];
let asrAudioLevel = 0;
let asrAudioLevelUpdatedAt = "";
let autoSubtitleRunning = false;
let autoSubtitleTimer = null;
let autoSubtitleTickRunning = false;
let autoSubtitleSeen = new Set();

const AUTO_INTERVAL_MS = 2500;
const AUTO_TIME_BUCKET_SECONDS = 4;
const AUTO_SEEN_STORAGE_KEY = "wordbook_auto_seen_v1";
const AUTO_JLPT_LEVELS_KEY = "wordbook_auto_jlpt_levels_v1";
const DEFAULT_AUTO_JLPT_LEVELS = ["N1", "N2", "N3"];

function releaseCaptureLock() {
  captureLock = false;
  captureLockStartedAt = 0;
  broadcastStatus("idle").catch(() => {});
}

async function broadcastStatus(status, message = "") {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((t) => t.id && t.url && t.url.includes("bilibili.com"));
  await Promise.all(
    targets.map(async (tab) => {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "POC_STATUS_UPDATE",
          status,
          message
        });
      } catch {
        // ignore non-injected tabs
      }
    })
  );
}

async function broadcastAutoWords(words) {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((t) => t.id && t.url && t.url.includes("bilibili.com"));
  await Promise.all(
    targets.map(async (tab) => {
      try {
        await ensureContentReady(tab.id);
        await chrome.tabs.sendMessage(tab.id, {
          type: "POC_AUTO_WORDS_UPDATE",
          words
        });
      } catch {}
    })
  );
}

async function clearAutoWords() {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((t) => t.id && t.url && t.url.includes("bilibili.com"));
  await Promise.all(
    targets.map(async (tab) => {
      try {
        await ensureContentReady(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: "POC_AUTO_WORDS_CLEAR" });
      } catch {}
    })
  );
}

async function ensureContentReady(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "POC_STATUS_UPDATE", status: "idle", message: "" });
    return;
  } catch {
    // not ready; inject the content script below
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content.js"]
  });
}

function pickBilibiliIds(urlString) {
  try {
    const url = new URL(urlString);
    const p = url.searchParams.get("p");
    const bvidMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const epMatch = url.pathname.match(/\/bangumi\/play\/(ep\d+)/);
    return {
      bvid: bvidMatch ? bvidMatch[1] : null,
      ep_id: epMatch ? epMatch[1].replace("ep", "") : null,
      p: p ? Number(p) : null
    };
  } catch {
    return { bvid: null, ep_id: null, p: null };
  }
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

function normalizeBilibiliPlaybackUrl(urlString, currentTime = 0, partIndex = null) {
  try {
    const url = new URL(urlString);
    const seconds = Math.max(0, Math.floor(Number(currentTime || 0)));
    const bvidMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const avMatch = url.pathname.match(/\/video\/(av\d+)/i);
    if (bvidMatch || avMatch) {
      const p = partIndex || url.searchParams.get("p");
      const clean = new URL(`${url.origin}/video/${bvidMatch ? bvidMatch[1] : avMatch[1]}`);
      if (p && Number(p) > 1) clean.searchParams.set("p", String(Number(p)));
      if (seconds > 0) clean.searchParams.set("t", String(seconds));
      return clean.toString();
    }
    const epMatch = url.pathname.match(/\/bangumi\/play\/(ep\d+)/);
    if (epMatch) {
      const clean = new URL(`${url.origin}/bangumi/play/${epMatch[1]}`);
      if (seconds > 0) clean.searchParams.set("t", String(seconds));
      return clean.toString();
    }
  } catch {
    // fall through
  }
  return urlString;
}

function makeAutoSeenKey(playback) {
  const ids = pickBilibiliIds(playback?.url || "");
  const mediaKey = ids.bvid || ids.ep_id || playback?.url || "unknown";
  const part = ids.p || playback?.p || 1;
  const bucket = Math.floor(Number(playback?.current_time || 0) / AUTO_TIME_BUCKET_SECONDS);
  return `${mediaKey}:p${part}:b${bucket}`;
}

async function loadAutoSeenKeys() {
  const data = await chrome.storage.local.get(AUTO_SEEN_STORAGE_KEY);
  const items = data[AUTO_SEEN_STORAGE_KEY];
  return new Set(Array.isArray(items) ? items.filter(Boolean) : []);
}

async function saveAutoSeenKeys() {
  await chrome.storage.local.set({
    [AUTO_SEEN_STORAGE_KEY]: Array.from(autoSubtitleSeen).slice(-5000)
  });
}

async function getAutoJlptLevels() {
  const data = await chrome.storage.local.get(AUTO_JLPT_LEVELS_KEY);
  const levels = data[AUTO_JLPT_LEVELS_KEY];
  return Array.isArray(levels) && levels.length ? levels : DEFAULT_AUTO_JLPT_LEVELS;
}

async function setAutoJlptLevels(levels) {
  const clean = (Array.isArray(levels) ? levels : [])
    .map((level) => String(level || "").toUpperCase())
    .filter((level) => /^N[1-5]$/.test(level));
  await chrome.storage.local.set({ [AUTO_JLPT_LEVELS_KEY]: clean });
  return clean;
}

async function getPlaybackContext(tabId) {
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector("video");
        const titleEl =
          document.querySelector("h1.video-title") ||
          document.querySelector("h1");
        const activePartEl =
          document.querySelector(".cur-list .on .part, .cur-list .on, .video-pod__item.active, .video-pod__item--active, .video-sections-item.active") ||
          document.querySelector("[class*='video-pod'] [class*='active']");
        const partText = activePartEl?.textContent?.trim() || "";
        const partIndexAttr =
          activePartEl?.getAttribute("data-index") ||
          activePartEl?.getAttribute("data-idx") ||
          activePartEl?.getAttribute("data-p") ||
          "";
        const partIndexMatch = partText.match(/(?:P|p|第)?\s*(\d+)\s*(?:集|话|話|P)?/);
        const urlP = new URL(window.location.href).searchParams.get("p");
        const inferredP = Number(urlP || partIndexAttr || (partIndexMatch ? partIndexMatch[1] : 0)) || null;
        const rect = video ? video.getBoundingClientRect() : null;
        return {
          url: window.location.href,
          title: titleEl ? titleEl.textContent.trim() : document.title,
          part_title: partText,
          p: inferredP,
          current_time: video ? Number(video.currentTime || 0) : 0,
          duration: video ? Number(video.duration || 0) : 0,
          video_rect: rect
            ? {
                x: Number(rect.left || 0),
                y: Number(rect.top || 0),
                width: Number(rect.width || 0),
                height: Number(rect.height || 0)
              }
            : null,
          viewport: {
            width: Number(window.innerWidth || 0),
            height: Number(window.innerHeight || 0)
          }
        };
      }
    });
    return injection?.[0]?.result || null;
  } catch (error) {
    const last = chrome.runtime.lastError?.message;
    throw new Error(last || String(error?.message || error));
  }
}

async function postPlaybackContext(payload) {
  const res = await fetchSidecar(`/playback/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Sidecar playback/context 失败（HTTP ${res.status}）${text ? `：${shortenForUi(text, 180)}` : ""}`
    );
  }
  return res.json();
}

async function postOcr(imageBase64, cropRect, viewport, lang = "") {
  const payload = {
    image_base64: imageBase64,
    languages: ["ja", "zh"]
  };
  if (cropRect && viewport) {
    payload.crop_rect = cropRect;
    payload.viewport = viewport;
  }
  if (lang) {
    payload.lang = lang;
  }

  const res = await fetchSidecar(`/ocr/recognize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ocr/recognize failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function postTokenize(text) {
  const normalizedText = normalizeOcrJapaneseText(text);
  const res = await fetchSidecar(`/ja/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: normalizedText })
  });
  if (!res.ok) {
    const textResp = await res.text();
    throw new Error(`ja/tokenize failed: ${res.status} ${textResp}`);
  }
  return res.json();
}

async function postDictLookup(lemma) {
  const res = await fetchSidecar(`/dict/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lemma })
  });
  if (!res.ok) {
    const textResp = await res.text();
    throw new Error(`dict/lookup failed: ${res.status} ${textResp}`);
  }
  return res.json();
}

function extractOcrTexts(ocrRes) {
  const ja = Array.isArray(ocrRes?.ja_lines) ? ocrRes.ja_lines.filter(Boolean) : [];
  const zh = Array.isArray(ocrRes?.zh_lines) ? ocrRes.zh_lines.filter(Boolean) : [];
  const rawTexts = Array.isArray(ocrRes?.raw_blocks)
    ? ocrRes.raw_blocks
        .map((x) => String(x?.text || "").trim())
        .filter(Boolean)
    : [];
  return { ja, zh, rawTexts };
}

async function postVocabAddItems(items) {
  const res = await fetchSidecar(`/vocab/add_items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`vocab/add_items failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function postShareSentence(sentenceId, comment) {
  const res = await fetchSidecar(`/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sentence_id: Number(sentenceId),
      comment: String(comment || ""),
      recipient_username: ""
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

async function getSpacePartnerInfo() {
  const res = await fetchSidecar("/space");
  if (!res.ok) return { partner: null };
  const data = await res.json();
  const partner = data?.partner ?? null;
  const username = partner && typeof partner === "object" ? String(partner.username || "").trim() : "";
  return { partner: username ? { username } : null };
}

async function postSentence(sentence) {
  const res = await fetchSidecar(`/sentences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sentence)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sentences failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function postVocabAddOne(item) {
  const res = await postVocabAddItems([item]);
  const id = Array.isArray(res?.created_item_ids) ? res.created_item_ids[0] : null;
  const sentenceId = Array.isArray(res?.sentence_ids) ? res.sentence_ids[0] : null;
  return id ? { ...item, vocab_item_id: id, sentence_id: sentenceId } : null;
}

async function deleteVocabItem(itemId) {
  const res = await fetchSidecar(`/vocab/items/${Number(itemId)}`, {
    method: "DELETE"
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`vocab delete failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function updateVocabItem(itemId, patch) {
  const res = await fetchSidecar(`/vocab/items/${Number(itemId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch || {})
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`vocab update failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function saveTokensAsVocab({ text, zhText = "", screenshotBase64 = null, playback = null, allowedJlptLevels = null, source = "auto" }) {
  const normalizedText = normalizeOcrJapaneseText(text);
  const tokenRes = normalizedText ? await postTokenize(normalizedText) : { tokens: [] };
  const allowed = allowedJlptLevels ? new Set(allowedJlptLevels) : null;
  const seenWords = new Set();
  const words = (tokenRes.tokens || [])
    .filter((token) => token?.surface && token?.dictionary_form)
    .filter((token) => token.surface !== "一" && token.dictionary_form !== "一")
    .filter((token) => !allowed || (token?.jlpt_level && allowed.has(token.jlpt_level)))
    .filter((token) => {
      const key = `${token.dictionary_form || token.surface}:${token.jlpt_level || ""}`;
      if (seenWords.has(key)) return false;
      seenWords.add(key);
      return true;
    })
    .map((token) => ({
      surface: token.surface,
      dictionary_form: token.dictionary_form || token.surface,
      reading: token.reading || "",
      jlpt_level: token.jlpt_level || "",
      source,
      meanings: Array.isArray(token.meanings) && token.meanings.length ? token.meanings : [token.dictionary_form || token.surface],
      example_ja: normalizedText,
      example_zh: zhText,
      screenshot_base64: screenshotBase64,
      playback
    }));
  const savedWords = [];
  for (const word of words) {
    const saved = await postVocabAddOne(word);
    if (saved) savedWords.push(saved);
  }
  if (savedWords.length) {
    const settings = await getSettings();
    await addRecentWords(savedWords, settings.maxRecentWords);
    await broadcastAutoWords(savedWords);
    return { words: savedWords, tokens: tokenRes.tokens || [] };
  }
  return { words: [], tokens: tokenRes.tokens || [] };
}

async function postAsrTranscribe(audioBase64) {
  const res = await fetchSidecar(`/asr/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_base64: audioBase64,
      language: "ja",
      with_vad: true
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`asr/transcribe failed: ${res.status} ${text}`);
  }
  return res.json();
}

function stopAsrState(reason = "") {
  asrRunning = false;
  asrChunkQueue.length = 0;
  asrAudioLevel = 0;
  asrAudioLevelUpdatedAt = new Date().toISOString();
  return reason;
}

async function drainAsrChunks() {
  if (!asrRunning || asrDrainRunning) return;
  asrDrainRunning = true;
  try {
    while (asrRunning && asrChunkQueue.length) {
      const audioBase64 = asrChunkQueue.shift();
      if (!audioBase64 || audioBase64.length < 500) continue;
      try {
        const asr = await postAsrTranscribe(String(audioBase64));
        if (asr?.text) {
          let savedCount = 0;
          try {
            const tab = await getActiveBilibiliTab();
            const playbackRes = await syncPlaybackContextFromTab(tab.id);
            const frameDataUrl = await captureVideoFrameDataUrl(tab.id);
            const allowedJlptLevels = await getAutoJlptLevels();
            const { words } = await saveTokensAsVocab({
              text: asr.text,
              screenshotBase64: frameDataUrl ? dataUrlToBase64(frameDataUrl) : null,
              playback: playbackRes.playback,
              allowedJlptLevels
            });
            savedCount = words.length;
          } catch (error) {
            console.warn("[wordbook] ASR auto-save failed", error);
          }
          recentAsrResults.unshift({
            text: asr.text,
            created_at: new Date().toISOString(),
            duration: asr.duration,
            saved_count: savedCount
          });
          recentAsrResults = recentAsrResults.slice(0, 20);
          await broadcastStatus("processing", `ASR 自动记录 ${savedCount} 个词`);
        }
      } catch (error) {
        await broadcastStatus("error", "语音识别失败");
        console.warn("[wordbook] ASR transcribe failed", error);
      }
    }
  } finally {
    asrDrainRunning = false;
    if (asrRunning && asrChunkQueue.length) void drainAsrChunks();
  }
}

async function captureFrameDataUrl() {
  return chrome.tabs.captureVisibleTab(undefined, { format: "png" });
}

function dataUrlToBase64(dataUrl) {
  const parts = dataUrl.split(",");
  return parts.length > 1 ? parts[1] : "";
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function cropScreenshotToVideoArea(dataUrl, cropRect, viewport) {
  if (!cropRect || !viewport) return dataUrl;
  const vpW = Number(viewport.width || 0);
  const vpH = Number(viewport.height || 0);
  const x = Number(cropRect.x || 0);
  const y = Number(cropRect.y || 0);
  const w = Number(cropRect.width || 0);
  const h = Number(cropRect.height || 0);
  if (vpW <= 0 || vpH <= 0 || w <= 0 || h <= 0) return dataUrl;

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scaleX = bitmap.width / vpW;
  const scaleY = bitmap.height / vpH;
  const sx = Math.max(0, Math.floor(x * scaleX));
  const sy = Math.max(0, Math.floor(y * scaleY));
  const sw = Math.min(bitmap.width - sx, Math.floor(w * scaleX));
  const sh = Math.min(bitmap.height - sy, Math.floor(h * scaleY));
  if (sw < 20 || sh < 20) return dataUrl;

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) return dataUrl;
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await croppedBlob.arrayBuffer());
  return `data:image/png;base64,${uint8ToBase64(bytes)}`;
}

async function cropDataUrlByVerticalRatio(dataUrl, topRatio, bottomRatio) {
  const top = Number(topRatio);
  const bottom = Number(bottomRatio);
  if (!(top >= 0 && top <= 1 && bottom >= 0 && bottom <= 1 && bottom > top)) {
    return dataUrl;
  }

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const sx = 0;
  const sy = Math.floor(bitmap.height * top);
  const sw = bitmap.width;
  const sh = Math.floor(bitmap.height * (bottom - top));
  if (sw < 20 || sh < 20) return dataUrl;

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) return dataUrl;
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await croppedBlob.arrayBuffer());
  return `data:image/png;base64,${uint8ToBase64(bytes)}`;
}

async function togglePlayback(tabId) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const video = document.querySelector("video");
      if (!video) {
        return { ok: false, error: "当前页面未找到 video 元素" };
      }

      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }

      return {
        ok: true,
        paused: video.paused,
        current_time: Number(video.currentTime || 0),
        duration: Number(video.duration || 0)
      };
    }
  });

  return injection?.[0]?.result || { ok: false, error: "播放控制失败" };
}

async function setPlaybackPaused(tabId, paused) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: (targetPaused) => {
      const video = document.querySelector("video");
      if (!video) {
        return { ok: false, error: "当前页面未找到 video 元素" };
      }
      if (targetPaused) {
        video.pause();
      } else {
        video.play();
      }
      return {
        ok: true,
        paused: video.paused,
        current_time: Number(video.currentTime || 0),
        duration: Number(video.duration || 0)
      };
    },
    args: [paused]
  });
  return injection?.[0]?.result || { ok: false, error: "播放状态设置失败" };
}

async function getActiveBilibiliTab() {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const tab =
    tabs.find((t) => t.active && t.url && t.url.includes("bilibili.com")) ||
    tabs.find((t) => t.url && t.url.includes("bilibili.com"));
  if (!tab?.id || !tab?.url) {
    throw new Error("无法获取当前标签页");
  }
  if (!tab.url.includes("bilibili.com")) {
    throw new Error("当前不是 B 站页面");
  }
  return tab;
}

async function ensureOverlayReady(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "POC_PING_OVERLAY" });
    if (pong?.ok) return;
  } catch {
    // not ready; will inject below
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["src/overlay.css"]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/overlay.js"]
  });
}

async function showOverlay(tabId, payload) {
  await ensureOverlayReady(tabId);
  const res = await chrome.tabs.sendMessage(tabId, {
    type: "POC_SHOW_OVERLAY",
    payload
  });
  if (!res?.ok) {
    const detail = res?.error ? String(res.error) : "";
    throw new Error(detail ? `页面内弹窗未能显示：${detail}` : "页面内弹窗未能显示");
  }
}

async function hideOverlay(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "POC_HIDE_OVERLAY" });
  } catch {
    // ignore
  }
}

async function captureVideoFrameDataUrl(tabId) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        const video = document.querySelector("video");
        if (!video) return { ok: false, error: "video not found" };
        const w = Math.floor(video.videoWidth || video.clientWidth || 0);
        const h = Math.floor(video.videoHeight || video.clientHeight || 0);
        if (w < 20 || h < 20) return { ok: false, error: "video frame too small" };
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return { ok: false, error: "canvas context unavailable" };
        ctx.drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/png");
        return { ok: true, dataUrl };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }
  });
  const res = injection?.[0]?.result;
  if (res?.ok && res?.dataUrl) return res.dataUrl;
  return null;
}

async function syncPlaybackContextFromTab(tabId) {
  const playback = await getPlaybackContext(tabId);
  if (!playback) {
    throw new Error("无法读取播放上下文");
  }

  const ids = pickBilibiliIds(playback.url);
  const playbackUrl = normalizeBilibiliPlaybackUrl(playback.url, playback.current_time, playback.p || ids.p);
  const contextPayload = {
    platform: "bilibili",
    ...compactObject(ids),
    ...playback,
    url: playbackUrl,
  };
  const contextRes = await postPlaybackContext(contextPayload);
  return {
    context_id: contextRes.context_id,
    playback: contextPayload
  };
}

async function runCapturePipeline(trigger = "unknown", options = {}) {
  if (captureLock && Date.now() - captureLockStartedAt > 120000) {
    // Stale lock safety valve.
    releaseCaptureLock();
  }
  if (captureLock && options.autoSave) {
    return { ok: true, skipped: true, reason: "capture_busy" };
  }
  if (captureLock && !options.autoSave) {
    await broadcastStatus("error", "请先完成当前保存");
    throw new Error("正在处理中，请先完成当前保存");
  }
  captureLock = true;
  captureLockStartedAt = Date.now();
  await broadcastStatus("processing", "正在识别中");
  const tab = await getActiveBilibiliTab();
  const settings = await getSettings();
  let pauseRes = null;
  if (settings.autoPauseOnCapture && !options.autoSave) {
    pauseRes = await setPlaybackPaused(tab.id, true);
  }

  const playbackRes = await syncPlaybackContextFromTab(tab.id);
  if (!options.autoSave) {
    await showOverlay(tab.id, {
      loading: true,
      require_save: true,
      playback: playbackRes.playback
    });
  }
  let playerFrameDataUrl = await captureVideoFrameDataUrl(tab.id);
  let captureSource = "video_element";
  if (!playerFrameDataUrl) {
    captureSource = "tab_capture_fallback";
    // Prevent loading overlay from being captured in fallback mode.
    await hideOverlay(tab.id);
    const screenshotDataUrl = await captureFrameDataUrl();
    playerFrameDataUrl = await cropScreenshotToVideoArea(
      screenshotDataUrl,
      playbackRes.playback.video_rect,
      playbackRes.playback.viewport
    );
    if (!options.autoSave) {
      await showOverlay(tab.id, {
        loading: true,
        require_save: true,
        playback: playbackRes.playback
      });
    }
  }
  const fullImageBase64 = dataUrlToBase64(playerFrameDataUrl);
  let ocrInputDataUrl = playerFrameDataUrl;
  if (settings.subtitleBandOnly) {
    ocrInputDataUrl = await cropDataUrlByVerticalRatio(
      ocrInputDataUrl,
      settings.subtitleBandTopRatio,
      settings.subtitleBandBottomRatio
    );
  }
  let ocrRes;
  if (settings.fixedSubtitleLayout) {
    const split = Number(settings.subtitleSplitRatio || 0.7);
    // Convention: 上 = 中文，下 = 日文。subtitleSplitRatio 表示中文区域从顶部算起的占比。
    const zhDataUrl = await cropDataUrlByVerticalRatio(ocrInputDataUrl, 0, split);
    const jaDataUrl = await cropDataUrlByVerticalRatio(ocrInputDataUrl, split, 1);
    const [zhOcr, jaOcr] = await Promise.all([
      postOcr(dataUrlToBase64(zhDataUrl), null, null, "ch"),
      postOcr(dataUrlToBase64(jaDataUrl), null, null, "japan")
    ]);
    const zhTexts = extractOcrTexts(zhOcr).rawTexts;
    const jaTexts = extractOcrTexts(jaOcr).rawTexts;
    ocrRes = {
      ja_lines: jaTexts,
      zh_lines: zhTexts,
      raw_blocks: [...(zhOcr.raw_blocks || []), ...(jaOcr.raw_blocks || [])]
    };
    console.warn("[wordbook] fixed subtitle layout mode", {
      split,
      zhCount: zhTexts.length,
      jaCount: jaTexts.length
    });
  } else {
    const imageBase64 = dataUrlToBase64(ocrInputDataUrl);
    ocrRes = await postOcr(
      imageBase64,
      playbackRes.playback.video_rect,
      playbackRes.playback.viewport
    );
  }
  console.log("[wordbook] OCR raw result", {
    captureSource,
    jaCount: Array.isArray(ocrRes?.ja_lines) ? ocrRes.ja_lines.length : 0,
    zhCount: Array.isArray(ocrRes?.zh_lines) ? ocrRes.zh_lines.length : 0,
    rawCount: Array.isArray(ocrRes?.raw_blocks) ? ocrRes.raw_blocks.length : 0
  });
  const jaLines = Array.isArray(ocrRes.ja_lines) ? ocrRes.ja_lines : [];
  const rawText = (ocrRes.raw_blocks || [])
    .map((x) => String(x?.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!jaLines.length && rawText) {
    // Fallback: when OCR language split misses Japanese lines,
    // still surface recognized text to overlay as editable JA sentence.
    ocrRes.ja_lines = [rawText];
    console.warn("[wordbook] ja_lines empty; fallback to raw_blocks text", {
      rawTextPreview: rawText.slice(0, 120)
    });
  }
  ocrRes.ja_lines = (ocrRes.ja_lines || []).map((line) => normalizeOcrJapaneseText(line));
  const jaText = (ocrRes.ja_lines || []).join(" ").trim();
  const tokenizeText = jaText || rawText;
  console.log("[wordbook] tokenize input", {
    source: jaText ? "ja_lines" : "raw_blocks",
    preview: tokenizeText.slice(0, 120)
  });
  const tokenRes = tokenizeText ? await postTokenize(tokenizeText) : { tokens: [] };
  console.log("[wordbook] token result", {
    tokenCount: Array.isArray(tokenRes?.tokens) ? tokenRes.tokens.length : 0
  });

  if (options.autoSave) {
    const allowedJlptLevels = await getAutoJlptLevels();
    const { words } = await saveTokensAsVocab({
      text: jaText || rawText,
      zhText: (ocrRes.zh_lines || []).join(" ").trim(),
      screenshotBase64: fullImageBase64,
      playback: playbackRes.playback,
      allowedJlptLevels
    });
    releaseCaptureLock();
    await broadcastStatus("processing", words.length ? `自动记录 ${words.length} 个词` : "自动识别：无新词");
    return {
      ok: true,
      action: "auto_subtitle_capture",
      saved_count: words.length,
      ...playbackRes,
      ocr: ocrRes,
      tokens: tokenRes.tokens || []
    };
  }

  const result = {
    ok: true,
    action: "capture_pipeline",
    trigger,
    settings,
    paused_by_capture: Boolean(pauseRes?.ok && pauseRes?.paused),
    ...playbackRes,
    ocr: ocrRes,
    tokens: tokenRes.tokens || [],
    screenshot_base64: fullImageBase64,
    screenshot_source: captureSource,
    require_save: true
  };
  lastCaptureResult = result;

  await showOverlay(tab.id, result);
  await broadcastStatus("processing", "请选择词条并保存");

  return result;
}

async function runAutoSubtitleTick() {
  if (!autoSubtitleRunning || autoSubtitleTickRunning) return;
  autoSubtitleTickRunning = true;
  try {
    const tab = await getActiveBilibiliTab();
    const playback = await getPlaybackContext(tab.id);
    if (!playback || playback.current_time <= 0) return;
    const key = makeAutoSeenKey(playback);
    if (autoSubtitleSeen.has(key)) return;
    autoSubtitleSeen.add(key);
    await saveAutoSeenKeys();
    await runCapturePipeline("auto_subtitle", { autoSave: true });
  } finally {
    autoSubtitleTickRunning = false;
  }
}

function scheduleAutoSubtitleTick(delay = AUTO_INTERVAL_MS) {
  if (!autoSubtitleRunning) return;
  if (autoSubtitleTimer) clearTimeout(autoSubtitleTimer);
  autoSubtitleTimer = setTimeout(async () => {
    try {
      await runAutoSubtitleTick();
    } catch (error) {
      console.warn("[wordbook] auto subtitle tick failed", error);
    } finally {
      scheduleAutoSubtitleTick(AUTO_INTERVAL_MS);
    }
  }, delay);
}

async function startAutoSubtitleMode() {
  if (autoSubtitleRunning) return { ok: true, running: true };
  autoSubtitleRunning = true;
  autoSubtitleSeen = await loadAutoSeenKeys();
  await broadcastStatus("processing", "字幕自动模式运行中");
  scheduleAutoSubtitleTick(0);
  return { ok: true, running: true };
}

async function stopAutoSubtitleMode() {
  autoSubtitleRunning = false;
  if (autoSubtitleTimer) clearTimeout(autoSubtitleTimer);
  autoSubtitleTimer = null;
  autoSubtitleTickRunning = false;
  releaseCaptureLock();
  await clearAutoWords();
  await broadcastStatus("idle", "字幕自动模式已停止");
  return { ok: true, running: false };
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== "capture-ocr-pipeline") return;
  runCapturePipeline("chrome_command").catch((error) => {
    releaseCaptureLock();
    const msg = formatPipelineFailure(error);
    console.error("[wordbook] capture pipeline failed (command)", error);
    broadcastStatus("error", msg ? `触发失败：${msg}` : "触发失败").catch(() => {});
    lastCaptureResult = {
      ok: false,
      action: "capture_pipeline",
      trigger: "chrome_command",
      error: String(error?.message || error)
    };
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (
      ![
        "POC_SYNC_PLAYBACK",
        "POC_TOGGLE_PLAYBACK",
        "POC_CAPTURE_PIPELINE",
        "POC_GET_LAST_CAPTURE_RESULT",
        "POC_GET_RECENT_WORDS",
        "POC_ADD_RECENT_WORDS",
        "POC_ADD_SENTENCE_ONLY",
        "POC_GET_SPACE_PARTNER",
        "POC_RESUME_PLAYBACK",
        "POC_RELEASE_CAPTURE_LOCK",
        "POC_DICT_LOOKUP",
        "POC_ASR_START",
        "POC_ASR_STOP",
        "POC_ASR_AUDIO_CHUNK",
        "POC_ASR_GET_RESULTS",
        "POC_ASR_LEVEL",
        "POC_ASR_STOPPED_BY_VIDEO",
        "POC_AUTO_SUBTITLE_START",
        "POC_AUTO_SUBTITLE_STOP",
        "POC_GET_MODES",
        "POC_SET_AUTO_JLPT_LEVELS",
        "POC_DELETE_VOCAB_ITEM"
      ].includes(message?.type)
    ) {
      return;
    }

    if (message.type === "POC_GET_SPACE_PARTNER") {
      try {
        const { partner } = await getSpacePartnerInfo();
        const username = partner?.username ? String(partner.username) : "";
        sendResponse({ ok: true, has_partner: Boolean(username), partner_username: username });
      } catch (error) {
        sendResponse({ ok: false, has_partner: false, partner_username: "", error: String(error?.message || error) });
      }
      return;
    }

    if (message.type === "POC_GET_LAST_CAPTURE_RESULT") {
      sendResponse({
        ok: true,
        result: lastCaptureResult
      });
      return;
    }

    if (message.type === "POC_GET_RECENT_WORDS") {
      const words = await getRecentWords();
      sendResponse({ ok: true, words });
      return;
    }

    if (message.type === "POC_ADD_RECENT_WORDS") {
      const settings = await getSettings();
      const words = Array.isArray(message?.words) ? message.words : [];
      const savedWords = [];
      for (const word of words) {
        const saved = await postVocabAddOne({ ...word, source: word.source || "manual" });
        if (saved) savedWords.push(saved);
      }
      const updated = await addRecentWords(savedWords, settings.maxRecentWords);
      releaseCaptureLock();
      await broadcastStatus("idle", savedWords.length ? "保存完成" : "已跳过重复词条");
      let shareError = "";
      if (
        Boolean(message.share_to_partner) &&
        savedWords.length &&
        Number(savedWords[0]?.sentence_id || 0) > 0
      ) {
        try {
          await postShareSentence(savedWords[0].sentence_id, String(message.partner_comment || ""));
          await broadcastStatus("idle", "已保存并已尝试分享给搭子");
        } catch (error) {
          shareError = String(error?.message || error);
        }
      }
      sendResponse({
        ok: true,
        count: updated.length,
        created_count: savedWords.length,
        skipped_count: Math.max(0, words.length - savedWords.length),
        share_error: shareError
      });
      return;
    }

    if (message.type === "POC_ADD_SENTENCE_ONLY") {
      const sentence = message?.sentence || {};
      const saved = await postSentence({ ...sentence, source: sentence.source || "manual" });
      releaseCaptureLock();
      await broadcastStatus("idle", "句子已保存");
      let shareError = "";
      if (Boolean(message.share_to_partner) && saved?.id) {
        try {
          await postShareSentence(saved.id, String(message.partner_comment || ""));
          await broadcastStatus("idle", "句子已保存并尝试分享给搭子");
        } catch (error) {
          shareError = String(error?.message || error);
        }
      }
      sendResponse({ ok: true, sentence: saved, share_error: shareError });
      return;
    }

    if (message.type === "POC_DELETE_VOCAB_ITEM") {
      const itemId = Number(message?.vocab_item_id || 0);
      if (!itemId) {
        sendResponse({ ok: false, error: "缺少词条 ID" });
        return;
      }
      await deleteVocabItem(itemId);
      await removeRecentWordByVocabItemId(itemId);
      sendResponse({ ok: true, deleted_item_id: itemId });
      return;
    }

    if (message.type === "POC_UPDATE_VOCAB_ITEM") {
      const itemId = Number(message?.vocab_item_id || 0);
      if (!itemId) {
        sendResponse({ ok: false, error: "缺少词条 ID" });
        return;
      }
      const patch = {
        surface: String(message?.surface || "").trim(),
        dictionary_form: String(message?.dictionary_form || "").trim(),
        reading: String(message?.reading || "").trim(),
        jlpt_level: String(message?.jlpt_level || "").trim(),
        meanings: Array.isArray(message?.meanings) ? message.meanings : [],
        example_ja: String(message?.example_ja || ""),
        example_zh: String(message?.example_zh || "")
      };
      if (!patch.surface) {
        sendResponse({ ok: false, error: "词面不能为空" });
        return;
      }
      const updated = await updateVocabItem(itemId, patch);
      await updateRecentWordByVocabItemId(itemId, updated);
      sendResponse({ ok: true, item: updated });
      return;
    }

    if (message.type === "POC_RELEASE_CAPTURE_LOCK") {
      releaseCaptureLock();
      await broadcastStatus("idle", "已取消");
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "POC_CAPTURE_PIPELINE") {
      try {
        const result = await runCapturePipeline(message?.source || "popup_button");
        sendResponse(result);
      } catch (error) {
        releaseCaptureLock();
        const msg = formatPipelineFailure(error);
        console.error("[wordbook] capture pipeline failed (message)", error);
        await broadcastStatus("error", msg ? `处理失败：${msg}` : "处理失败");
        throw error;
      }
      return;
    }

    if (message.type === "POC_DICT_LOOKUP") {
      const result = await postDictLookup(String(message?.lemma || ""));
      sendResponse({ ok: true, result });
      return;
    }

    if (message.type === "POC_GET_MODES") {
      sendResponse({
        ok: true,
        auto_subtitle_running: autoSubtitleRunning,
        asr_running: asrRunning,
        auto_seen_count: autoSubtitleSeen.size,
        auto_jlpt_levels: await getAutoJlptLevels()
      });
      return;
    }

    if (message.type === "POC_SET_AUTO_JLPT_LEVELS") {
      const levels = await setAutoJlptLevels(message?.levels || []);
      sendResponse({ ok: true, levels });
      return;
    }

    if (message.type === "POC_AUTO_SUBTITLE_START") {
      const result = await startAutoSubtitleMode();
      sendResponse(result);
      return;
    }

    if (message.type === "POC_AUTO_SUBTITLE_STOP") {
      const result = await stopAutoSubtitleMode();
      sendResponse(result);
      return;
    }

    if (message.type === "POC_ASR_START") {
      const tab = await getActiveBilibiliTab();
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "POC_ASR_CONTROL",
        action: "start",
        interval_ms: 15000
      });
      if (!res?.ok) {
        stopAsrState();
        sendResponse({ ok: false, error: res?.error || "语音识别启动失败", running: false });
        return;
      }
      asrRunning = Boolean(res?.ok);
      asrAudioLevel = 0;
      asrAudioLevelUpdatedAt = new Date().toISOString();
      await broadcastStatus("processing", "语音识别运行中（15秒分片）");
      sendResponse({ ok: true, running: asrRunning });
      return;
    }

    if (message.type === "POC_ASR_STOP") {
      const tab = await getActiveBilibiliTab();
      await chrome.tabs.sendMessage(tab.id, {
        type: "POC_ASR_CONTROL",
        action: "stop"
      });
      stopAsrState("manual");
      await clearAutoWords();
      await broadcastStatus("idle", "语音识别已停止");
      sendResponse({ ok: true, running: false });
      return;
    }

    if (message.type === "POC_ASR_AUDIO_CHUNK") {
      if (!asrRunning) {
        sendResponse({ ok: true, skipped: true });
        return;
      }
      const audioBase64 = String(message?.audio_base64 || "");
      if (audioBase64.length < 500) {
        sendResponse({ ok: true, skipped: true });
        return;
      }
      asrChunkQueue.push(audioBase64);
      while (asrChunkQueue.length > ASR_CHUNK_QUEUE_CAP) {
        asrChunkQueue.shift();
      }
      sendResponse({ ok: true, queued: true });
      void drainAsrChunks();
      return;
    }

    if (message.type === "POC_ASR_GET_RESULTS") {
      sendResponse({
        ok: true,
        running: asrRunning,
        results: recentAsrResults,
        audio_level: asrAudioLevel,
        audio_level_updated_at: asrAudioLevelUpdatedAt
      });
      return;
    }

    if (message.type === "POC_ASR_LEVEL") {
      if (!asrRunning) {
        sendResponse({ ok: true, skipped: true });
        return;
      }
      asrAudioLevel = Math.max(0, Math.min(1, Number(message?.level || 0)));
      asrAudioLevelUpdatedAt = new Date().toISOString();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "POC_ASR_STOPPED_BY_VIDEO") {
      const reason = String(message?.reason || "");
      stopAsrState(reason);
      const messageText = reason === "video_paused" ? "视频暂停，语音识别已停止" : "视频停止，语音识别已停止";
      await broadcastStatus("idle", messageText);
      sendResponse({ ok: true, running: false, reason });
      return;
    }

    const tab = await getActiveBilibiliTab();

    if (message.type === "POC_TOGGLE_PLAYBACK") {
      const toggleRes = await togglePlayback(tab.id);
      if (!toggleRes.ok) {
        throw new Error(toggleRes.error || "播放控制失败");
      }
      sendResponse({
        ok: true,
        action: "toggle_playback",
        playback: toggleRes
      });
      return;
    }

    if (message.type === "POC_RESUME_PLAYBACK") {
      const resumeRes = await setPlaybackPaused(tab.id, false);
      if (!resumeRes.ok) {
        throw new Error(resumeRes.error || "恢复播放失败");
      }
      sendResponse({
        ok: true,
        action: "resume_playback",
        playback: resumeRes
      });
      return;
    }

    const playbackRes = await syncPlaybackContextFromTab(tab.id);
    sendResponse({
      ok: true,
      ...playbackRes
    });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: String(error?.message || error)
    });
  });

  return true;
});

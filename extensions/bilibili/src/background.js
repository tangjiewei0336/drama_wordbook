import { addRecentWords, getRecentWords, getSettings } from "./storage.js";

const SIDECAR_BASE = "http://127.0.0.1:17321";
let lastCaptureResult = null;
let captureLock = false;
let captureLockStartedAt = 0;

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

async function getPlaybackContext(tabId) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const video = document.querySelector("video");
      const titleEl =
        document.querySelector("h1.video-title") ||
        document.querySelector("h1");
      const rect = video ? video.getBoundingClientRect() : null;
      return {
        url: window.location.href,
        title: titleEl ? titleEl.textContent.trim() : document.title,
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
}

async function postPlaybackContext(payload) {
  const res = await fetch(`${SIDECAR_BASE}/playback/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`playback/context failed: ${res.status}`);
  }
  return res.json();
}

async function postOcr(imageBase64, cropRect, viewport) {
  const payload = {
    image_base64: imageBase64,
    languages: ["ja", "zh"]
  };
  if (cropRect && viewport) {
    payload.crop_rect = cropRect;
    payload.viewport = viewport;
  }

  const res = await fetch(`${SIDECAR_BASE}/ocr/recognize`, {
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
  const res = await fetch(`${SIDECAR_BASE}/ja/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
    const textResp = await res.text();
    throw new Error(`ja/tokenize failed: ${res.status} ${textResp}`);
  }
  return res.json();
}

async function postDictLookup(lemma) {
  const res = await fetch(`${SIDECAR_BASE}/dict/lookup`, {
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
  const res = await fetch(`${SIDECAR_BASE}/vocab/add_items`, {
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
    throw new Error("页面内弹窗未能显示");
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
  const contextPayload = {
    platform: "bilibili",
    ...playback,
    ...ids
  };
  const contextRes = await postPlaybackContext(contextPayload);
  return {
    context_id: contextRes.context_id,
    playback: contextPayload
  };
}

async function runCapturePipeline(trigger = "unknown") {
  if (captureLock && Date.now() - captureLockStartedAt > 120000) {
    // Stale lock safety valve.
    releaseCaptureLock();
  }
  if (captureLock) {
    await broadcastStatus("error", "请先完成当前保存");
    throw new Error("正在处理中，请先完成当前保存");
  }
  captureLock = true;
  captureLockStartedAt = Date.now();
  await broadcastStatus("processing", "正在识别中");
  const tab = await getActiveBilibiliTab();
  const settings = await getSettings();
  let pauseRes = null;
  if (settings.autoPauseOnCapture) {
    pauseRes = await setPlaybackPaused(tab.id, true);
  }

  const playbackRes = await syncPlaybackContextFromTab(tab.id);
  await showOverlay(tab.id, {
    loading: true,
    require_save: true,
    playback: playbackRes.playback
  });
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
    await showOverlay(tab.id, {
      loading: true,
      require_save: true,
      playback: playbackRes.playback
    });
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
    const split = Number(settings.subtitleSplitRatio || 0.5);
    const zhDataUrl = await cropDataUrlByVerticalRatio(ocrInputDataUrl, 0, split);
    const jaDataUrl = await cropDataUrlByVerticalRatio(ocrInputDataUrl, split, 1);
    const zhOcr = await postOcr(dataUrlToBase64(zhDataUrl), null, null);
    const jaOcr = await postOcr(dataUrlToBase64(jaDataUrl), null, null);
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

chrome.commands.onCommand.addListener((command) => {
  if (command !== "capture-ocr-pipeline") return;
  runCapturePipeline("chrome_command").catch((error) => {
    releaseCaptureLock();
    broadcastStatus("error", "触发失败").catch(() => {});
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
        "POC_RESUME_PLAYBACK",
        "POC_RELEASE_CAPTURE_LOCK",
        "POC_DICT_LOOKUP"
      ].includes(message?.type)
    ) {
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
      if (words.length) {
        await postVocabAddItems(words);
      }
      const updated = await addRecentWords(words, settings.maxRecentWords);
      releaseCaptureLock();
      await broadcastStatus("idle", "保存完成");
      sendResponse({
        ok: true,
        count: updated.length
      });
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
        await broadcastStatus("error", "处理失败");
        throw error;
      }
      return;
    }

    if (message.type === "POC_DICT_LOOKUP") {
      const result = await postDictLookup(String(message?.lemma || ""));
      sendResponse({ ok: true, result });
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

const captureBtn = document.getElementById("captureBtn");
const asrStartBtn = document.getElementById("asrStartBtn");
const asrStopBtn = document.getElementById("asrStopBtn");
const dashboardBtn = document.getElementById("dashboardBtn");
const syncBtn = document.getElementById("syncBtn");
const settingsBtn = document.getElementById("settingsBtn");
const asrListEl = document.getElementById("asrList");
const audioMeterFillEl = document.getElementById("audioMeterFill");
const audioMeterMetaEl = document.getElementById("audioMeterMeta");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || "";
  }
}

function renderWords(words) {
  if (!Array.isArray(words) || words.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无词条。先在视频页按截图键添加一个词试试。</div>';
    return;
  }

  listEl.innerHTML = words
    .map((word) => {
      const meanings = Array.isArray(word.meanings) ? word.meanings.filter(Boolean).join("；") : "";
      const reading = word.reading ? `<span class="reading">${word.reading}</span>` : "";
      const jlpt = word.jlpt_level ? `<span class="reading">${word.jlpt_level}</span>` : "";
      const currentTime = Number(word?.playback?.current_time || 0).toFixed(1);
      return `
        <div class="word-item">
          <div class="word-head">
            <span class="surface">${word.surface || ""}</span>
            ${reading}
            ${jlpt}
          </div>
          <div class="meaning">${meanings || word.dictionary_form || ""}</div>
          <div class="meta">${formatTime(word.created_at)} · ${word?.playback?.title || "未知来源"} @ ${currentTime}s</div>
        </div>
      `;
    })
    .join("");
}

async function loadRecentWords() {
  const res = await chrome.runtime.sendMessage({ type: "POC_GET_RECENT_WORDS" });
  if (!res?.ok) {
    throw new Error(res?.error || "读取词条失败");
  }
  renderWords(res.words || []);
}

function renderAsrResults(data) {
  const items = Array.isArray(data?.results) ? data.results : [];
  if (!items.length) {
    asrListEl.innerHTML = '<div class="empty">ASR 暂无结果</div>';
    return;
  }
  asrListEl.innerHTML = items
    .map(
      (x) =>
        `<div class="word-item"><div class="meaning">${x.text || ""}</div><div class="meta">${formatTime(
          x.created_at
        )} · ${(Number(x.duration || 0)).toFixed(1)}s</div></div>`
    )
    .join("");
}

function renderAudioMeter(level, updatedAt, running) {
  const v = Math.max(0, Math.min(1, Number(level || 0)));
  if (audioMeterFillEl) {
    audioMeterFillEl.style.width = `${(v * 100).toFixed(0)}%`;
  }
  if (audioMeterMetaEl) {
    const stateText = running ? "采集中" : "未运行";
    const ts = updatedAt ? formatTime(updatedAt) : "暂无";
    audioMeterMetaEl.textContent = `${stateText} · 强度 ${(v * 100).toFixed(0)}% · 更新时间 ${ts}`;
  }
}

async function loadAsrResults() {
  const res = await chrome.runtime.sendMessage({ type: "POC_ASR_GET_RESULTS" });
  if (!res?.ok) return;
  renderAsrResults(res);
  renderAudioMeter(res.audio_level, res.audio_level_updated_at, res.running);
}

captureBtn.addEventListener("click", async () => {
  setStatus("执行截图识别中...");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "POC_CAPTURE_PIPELINE",
      source: "popup_manual_button"
    });
    if (!res?.ok) throw new Error(res?.error || "截图识别失败");
    setStatus("已触发截图识别，请在页面内弹窗继续添加词条");
    await loadRecentWords();
  } catch (error) {
    setStatus(`截图识别失败: ${String(error?.message || error)}`);
  }
});

dashboardBtn.addEventListener("click", async () => {
  const url = chrome.runtime.getURL("dashboard/dashboard.html");
  await chrome.tabs.create({ url });
});

asrStartBtn.addEventListener("click", async () => {
  setStatus("正在启动语音识别...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "POC_ASR_START" });
    if (!res?.ok) throw new Error(res?.error || "启动失败");
    setStatus("ASR 已启动，每 15 秒转写一次；视频暂停会自动停止");
  } catch (error) {
    setStatus(`ASR 启动失败: ${String(error?.message || error)}`);
  }
});

asrStopBtn.addEventListener("click", async () => {
  setStatus("正在停止语音识别...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "POC_ASR_STOP" });
    if (!res?.ok) throw new Error(res?.error || "停止失败");
    setStatus("ASR 已停止");
  } catch (error) {
    setStatus(`ASR 停止失败: ${String(error?.message || error)}`);
  }
});

syncBtn.addEventListener("click", async () => {
  setStatus("同步中...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "POC_SYNC_PLAYBACK" });
    if (!res?.ok) throw new Error(res?.error || "同步失败");
    setStatus("播放信息已同步");
  } catch (error) {
    setStatus(`同步失败: ${String(error?.message || error)}`);
  }
});

settingsBtn.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

loadRecentWords().catch((error) => {
  setStatus(`加载失败: ${String(error?.message || error)}`);
});
loadAsrResults();
setInterval(loadAsrResults, 5000);

const dashboardBtn = document.getElementById("dashboardBtn");
const settingsBtn = document.getElementById("settingsBtn");
const modeSwitchEl = document.getElementById("modeSwitch");
const modeButtons = Array.from(document.querySelectorAll(".mode-option"));
const primaryModeBtn = document.getElementById("primaryModeBtn");
const stopModeBtn = document.getElementById("stopModeBtn");
const primaryRowEl = primaryModeBtn.parentElement;
const jlptFiltersEl = document.getElementById("jlptFilters");
const levelInputs = Array.from(jlptFiltersEl.querySelectorAll("input[type='checkbox']"));
const meterWrapEl = document.getElementById("meterWrap");
const asrListEl = document.getElementById("asrList");
const audioMeterFillEl = document.getElementById("audioMeterFill");
const audioMeterMetaEl = document.getElementById("audioMeterMeta");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");

let activeMode = "manual";
const MODE_STORAGE_KEY = "wordbook_popup_mode_v1";
let modeState = {
  auto_subtitle_running: false,
  asr_running: false,
  auto_seen_count: 0,
  auto_jlpt_levels: ["N1", "N2", "N3"]
};

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
    listEl.innerHTML = '<div class="empty">暂无词条。先在视频页添加一个词试试。</div>';
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
  if (!res?.ok) throw new Error(res?.error || "读取词条失败");
  renderWords(res.words || []);
}

function renderAsrResults(data) {
  const items = Array.isArray(data?.results) ? data.results : [];
  if (!items.length) {
    asrListEl.innerHTML = activeMode === "asr" ? '<div class="empty">ASR 暂无结果</div>' : "";
    return;
  }
  asrListEl.innerHTML = items
    .map(
      (x) =>
        `<div class="word-item"><div class="meaning">${x.text || ""}</div><div class="meta">${formatTime(
          x.created_at
        )} · ${(Number(x.duration || 0)).toFixed(1)}s · 已保存 ${Number(x.saved_count || 0)} 个词</div></div>`
    )
    .join("");
}

function renderAudioMeter(level, updatedAt, running) {
  const v = Math.max(0, Math.min(1, Number(level || 0)));
  audioMeterFillEl.style.width = `${(v * 100).toFixed(0)}%`;
  const stateText = running ? "采集中" : "未运行";
  const ts = updatedAt ? formatTime(updatedAt) : "暂无";
  audioMeterMetaEl.textContent = `${stateText} · 强度 ${(v * 100).toFixed(0)}% · 更新时间 ${ts}`;
}

async function loadAsrResults() {
  const res = await chrome.runtime.sendMessage({ type: "POC_ASR_GET_RESULTS" });
  if (!res?.ok) return;
  renderAsrResults(res);
  renderAudioMeter(res.audio_level, res.audio_level_updated_at, res.running);
}

async function loadModes() {
  const res = await chrome.runtime.sendMessage({ type: "POC_GET_MODES" });
  if (!res?.ok) return;
  modeState = { ...modeState, ...res };
  syncLevelInputs();
  renderMode();
}

function syncLevelInputs() {
  const selected = new Set(modeState.auto_jlpt_levels || []);
  levelInputs.forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function selectedLevels() {
  return levelInputs.filter((input) => input.checked).map((input) => input.value);
}

function setMode(mode) {
  activeMode = mode;
  chrome.storage.local.set({ [MODE_STORAGE_KEY]: mode }).catch(() => {});
  modeSwitchEl.dataset.mode = mode;
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  renderMode();
}

function renderMode() {
  const autoActive = Boolean(modeState.auto_subtitle_running);
  const asrActive = Boolean(modeState.asr_running);
  const showStop = (activeMode === "auto" && autoActive) || (activeMode === "asr" && asrActive);
  jlptFiltersEl.style.display = activeMode === "auto" || activeMode === "asr" ? "flex" : "none";
  meterWrapEl.style.display = activeMode === "asr" ? "block" : "none";
  asrListEl.style.display = activeMode === "asr" ? "block" : "none";
  primaryRowEl.classList.toggle("has-stop", showStop);
  stopModeBtn.style.display = showStop ? "block" : "none";

  if (activeMode === "manual") {
    primaryModeBtn.textContent = "手动截图识别";
  } else if (activeMode === "auto") {
    primaryModeBtn.textContent = autoActive ? `字幕自动运行中 · ${modeState.auto_seen_count || 0} 段` : "启动字幕自动";
  } else {
    primaryModeBtn.textContent = asrActive ? "ASR 运行中" : "启动 ASR";
  }
}

async function saveLevelFilter() {
  const levels = selectedLevels();
  const res = await chrome.runtime.sendMessage({ type: "POC_SET_AUTO_JLPT_LEVELS", levels });
  if (res?.ok) {
    modeState.auto_jlpt_levels = res.levels || levels;
    setStatus(`自动保存级别：${(modeState.auto_jlpt_levels || []).join(" / ") || "未选择"}`);
  }
}

async function runPrimaryAction() {
  if (activeMode === "manual") {
    setStatus("执行截图识别中...");
    const res = await chrome.runtime.sendMessage({ type: "POC_CAPTURE_PIPELINE", source: "popup_manual_button" });
    if (!res?.ok) throw new Error(res?.error || "截图识别失败");
    setStatus("已触发截图识别，请在页面内弹窗继续添加词条");
    await loadRecentWords();
    return;
  }

  await saveLevelFilter();
  if (activeMode === "auto") {
    setStatus("正在启动字幕自动模式...");
    const res = await chrome.runtime.sendMessage({ type: "POC_AUTO_SUBTITLE_START" });
    if (!res?.ok) throw new Error(res?.error || "启动失败");
    setStatus("字幕自动模式已启动");
    await loadModes();
    return;
  }

  setStatus("正在启动 ASR...");
  const res = await chrome.runtime.sendMessage({ type: "POC_ASR_START" });
  if (!res?.ok) throw new Error(res?.error || "启动失败");
  setStatus("ASR 已启动，视频暂停会自动停止");
  await loadModes();
}

async function stopActiveMode() {
  if (activeMode === "auto") {
    const res = await chrome.runtime.sendMessage({ type: "POC_AUTO_SUBTITLE_STOP" });
    if (!res?.ok) throw new Error(res?.error || "停止失败");
    setStatus("字幕自动模式已停止");
  } else if (activeMode === "asr") {
    const res = await chrome.runtime.sendMessage({ type: "POC_ASR_STOP" });
    if (!res?.ok) throw new Error(res?.error || "停止失败");
    setStatus("ASR 已停止");
  }
  await loadModes();
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

levelInputs.forEach((input) => {
  input.addEventListener("change", () => {
    saveLevelFilter().catch((error) => setStatus(`筛选保存失败: ${String(error?.message || error)}`));
  });
});

primaryModeBtn.addEventListener("click", () => {
  runPrimaryAction().catch((error) => setStatus(`操作失败: ${String(error?.message || error)}`));
});

stopModeBtn.addEventListener("click", () => {
  stopActiveMode().catch((error) => setStatus(`停止失败: ${String(error?.message || error)}`));
});

dashboardBtn.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});

settingsBtn.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

loadRecentWords().catch((error) => setStatus(`加载失败: ${String(error?.message || error)}`));
chrome.storage.local.get(MODE_STORAGE_KEY).then((data) => {
  const saved = data?.[MODE_STORAGE_KEY];
  if (["manual", "auto", "asr"].includes(saved)) {
    setMode(saved);
  } else {
    renderMode();
  }
}).catch(() => renderMode());
loadModes().catch(() => {});
loadAsrResults();
setInterval(loadAsrResults, 5000);
setInterval(loadModes, 5000);

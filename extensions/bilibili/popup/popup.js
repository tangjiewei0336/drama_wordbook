const captureBtn = document.getElementById("captureBtn");
const dashboardBtn = document.getElementById("dashboardBtn");
const syncBtn = document.getElementById("syncBtn");
const settingsBtn = document.getElementById("settingsBtn");
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
      const currentTime = Number(word?.playback?.current_time || 0).toFixed(1);
      return `
        <div class="word-item">
          <div class="word-head">
            <span class="surface">${word.surface || ""}</span>
            ${reading}
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

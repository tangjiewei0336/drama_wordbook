const OVERLAY_ROOT_ID = "wordbook-overlay-root";

function safeText(value) {
  return typeof value === "string" ? value : "";
}

function removeOverlay() {
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing) existing.remove();
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (typeof text === "string") el.textContent = text;
  return el;
}

function calcCardPosition(videoRect) {
  if (!videoRect || videoRect.width <= 0 || videoRect.height <= 0) {
    return { left: 16, top: 16 };
  }
  const cardWidth = Math.min(520, window.innerWidth - 32);
  const left = Math.max(16, Math.min(videoRect.x + videoRect.width - cardWidth - 12, window.innerWidth - cardWidth - 16));
  const top = Math.max(16, Math.min(videoRect.y + 12, window.innerHeight - 240));
  return { left, top };
}

function getDefaultMeaning(token) {
  return token?.dictionary_form || token?.surface || "";
}

function pickJlptLevel(tokens, indices) {
  return Array.from(indices)
    .sort((a, b) => a - b)
    .map((idx) => safeText(tokens[idx]?.jlpt_level))
    .filter(Boolean)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0] || "";
}

async function lookupMeaning(lemma) {
  const res = await chrome.runtime.sendMessage({
    type: "POC_DICT_LOOKUP",
    lemma
  });
  if (!res?.ok) return null;
  return res.result || null;
}

function renderOverlay(payload) {
  removeOverlay();

  const root = createEl("div", "wb-overlay-root");
  root.id = OVERLAY_ROOT_ID;
  const mask = createEl("div", "wb-overlay-mask");
  const card = createEl("div", "wb-overlay-card");

  const title = createEl("div", "wb-overlay-title", "添加到词典");
  const meta = createEl(
    "div",
    "wb-overlay-meta",
    `${safeText(payload?.playback?.title) || "未知标题"} · ${Number(payload?.playback?.current_time || 0).toFixed(1)}s`
  );

  const jaSection = createEl("div", "wb-overlay-section");
  jaSection.appendChild(createEl("div", "wb-overlay-label", "日语例句"));
  const jaTextarea = createEl("textarea", "wb-overlay-textarea");
  jaTextarea.value = safeText(payload?.ocr?.ja_lines?.join(" "));
  jaSection.appendChild(jaTextarea);

  const zhSection = createEl("div", "wb-overlay-section");
  zhSection.appendChild(createEl("div", "wb-overlay-label", "中文例句（可选）"));
  const zhTextarea = createEl("textarea", "wb-overlay-textarea");
  zhTextarea.value = safeText(payload?.ocr?.zh_lines?.join(" "));
  zhSection.appendChild(zhTextarea);

  const tokenSection = createEl("div", "wb-overlay-section");
  tokenSection.appendChild(createEl("div", "wb-overlay-label", "选择字符/词片段（可多选，自动拼接）"));
  const tokenList = createEl("div", "wb-overlay-token-list");
  const tokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
  const selectedIndices = new Set();
  if (tokens.length > 0) selectedIndices.add(0);
  let addBtnHandler = async () => {};

  if (tokens.length === 0) {
    tokenList.appendChild(createEl("div", "", "未识别到可用日语分词。"));
  } else {
    const composedWordInput = createEl("input", "wb-overlay-meaning-input");
    composedWordInput.placeholder = "最终要添加的词（由上方选择自动拼接）";
    let composedEdited = false;
    const dictPreview = createEl("div", "wb-overlay-dict-preview");
    dictPreview.innerHTML = '<span class="muted">词典提示将显示在这里</span>';
    let lookupSeq = 0;

    composedWordInput.addEventListener("input", () => {
      composedEdited = true;
      refreshDictionaryPreview().catch(() => {});
    });

    const meaningInput = createEl("input", "wb-overlay-meaning-input");
    meaningInput.placeholder = "释义（可选，用 ; 分隔多条）";
    const readingHint = createEl("div", "wb-overlay-label", "");

    const getComposedTokenText = () =>
      Array.from(selectedIndices)
        .sort((a, b) => a - b)
        .map((idx) => safeText(tokens[idx]?.surface))
        .join("");

    const getComposedDictionaryForm = () =>
      Array.from(selectedIndices)
        .sort((a, b) => a - b)
        .map((idx) => safeText(tokens[idx]?.dictionary_form || tokens[idx]?.surface))
        .join("");

    const getComposedReading = () =>
      Array.from(selectedIndices)
        .sort((a, b) => a - b)
        .map((idx) => safeText(tokens[idx]?.reading))
        .filter(Boolean)
        .join("");

    const getComposedJlptLevel = () => pickJlptLevel(tokens, selectedIndices);

    const refreshDictionaryPreview = async () => {
      const lookupKey = composedWordInput.value.trim() || getComposedTokenText();
      if (!lookupKey) {
        dictPreview.innerHTML = '<span class="muted">词典提示将显示在这里</span>';
        return;
      }

      const seq = ++lookupSeq;
      dictPreview.innerHTML = '<span class="muted">词典查询中...</span>';
      const dict = await lookupMeaning(lookupKey);
      if (seq !== lookupSeq) return;

      if (dict?.meanings?.length) {
        meaningInput.value = dict.meanings.join("；");
        const jlptLevel = getComposedJlptLevel();
        readingHint.textContent = [dict?.reading ? `读音: ${dict.reading}` : "", jlptLevel ? `JLPT: ${jlptLevel}` : ""]
          .filter(Boolean)
          .join(" · ");
        dictPreview.innerHTML = `
          <div><strong>释义</strong>：${dict.meanings.join("；")}</div>
          <div class="muted">${[dict?.reading ? `读音：${dict.reading}` : "无读音信息", jlptLevel ? `JLPT：${jlptLevel}` : ""]
            .filter(Boolean)
            .join(" · ")}</div>
        `;
      } else {
        const jlptLevel = getComposedJlptLevel();
        readingHint.textContent = jlptLevel ? `JLPT: ${jlptLevel}` : "";
        dictPreview.innerHTML = '<span class="muted">未命中词典，请手动填写释义</span>';
      }
    };

    const refreshBubbleState = async () => {
      Array.from(tokenList.querySelectorAll(".wb-overlay-token-bubble")).forEach((btn, idx) => {
        btn.classList.toggle("active", selectedIndices.has(idx));
      });
      const composedSurface = getComposedTokenText();
      if (!composedEdited) {
        composedWordInput.value = composedSurface;
      }
      await refreshDictionaryPreview();
    };

    tokens.forEach((token, index) => {
      const bubble = createEl(
        "button",
        `wb-overlay-token-bubble${selectedIndices.has(index) ? " active" : ""}`,
        ""
      );
      bubble.type = "button";
      const level = safeText(token.jlpt_level);
      bubble.title = [safeText(token.dictionary_form || token.surface), level].filter(Boolean).join(" · ");
      bubble.appendChild(createEl("span", "", safeText(token.surface)));
      if (level) bubble.appendChild(createEl("small", "wb-overlay-token-level", level));
      bubble.addEventListener("click", () => {
        if (selectedIndices.has(index)) {
          selectedIndices.delete(index);
        } else {
          selectedIndices.add(index);
        }
        refreshBubbleState().catch(() => {});
      });
      tokenList.appendChild(bubble);
    });

    refreshBubbleState().catch(() => {});
    tokenSection.appendChild(tokenList);
    tokenSection.appendChild(composedWordInput);
    tokenSection.appendChild(dictPreview);
    tokenSection.appendChild(meaningInput);
    tokenSection.appendChild(readingHint);

    addBtnHandler = async () => {
      status.textContent = "保存中...";
      if (!selectedIndices.size) {
        status.textContent = "请至少选择一个字符/词片段";
        return;
      }
      const composedSurface = safeText(composedWordInput.value).trim() || getComposedTokenText();
      const composedDictionaryForm = getComposedDictionaryForm() || composedSurface;
      const composedReading = readingHint.textContent.split("·")[0].replace(/^读音:\s*/, "").trim() || getComposedReading();
      const composedJlptLevel = getComposedJlptLevel();
      const meanings = safeText(meaningInput.value)
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean);
      const words = [
        {
          surface: composedSurface,
          dictionary_form: composedDictionaryForm,
          reading: composedReading,
          jlpt_level: composedJlptLevel,
          meanings: meanings.length ? meanings : [composedDictionaryForm || composedSurface],
          example_ja: safeText(jaTextarea.value),
          example_zh: safeText(zhTextarea.value),
          screenshot_base64: safeText(payload?.screenshot_base64) || null,
          playback: payload?.playback || null
        }
      ].filter((x) => x.surface);

      if (!words.length) {
        status.textContent = "可保存词为空";
        return;
      }

      const saveRes = await chrome.runtime.sendMessage({
        type: "POC_ADD_RECENT_WORDS",
        words
      });
      if (!saveRes?.ok) {
        status.textContent = `保存失败: ${safeText(saveRes?.error)}`;
        return;
      }
      status.textContent = "已保存 1 个词";
    };
  }
  if (tokens.length === 0) {
    tokenSection.appendChild(tokenList);
  }

  const actions = createEl("div", "wb-overlay-actions");
  const addBtn = createEl("button", "wb-btn wb-btn-primary", "添加到词典");
  const closeBtn = createEl("button", "wb-btn wb-btn-default", "取消本次");
  const resumeBtn = createEl("button", "wb-btn wb-btn-default", "恢复播放");
  actions.appendChild(addBtn);
  actions.appendChild(closeBtn);
  actions.appendChild(resumeBtn);

  const status = createEl("div", "wb-overlay-status");
  let saved = false;
  if (!tokens.length) {
    addBtnHandler = async () => {
      await chrome.runtime.sendMessage({ type: "POC_RELEASE_CAPTURE_LOCK" });
      status.textContent = "未识别到可添加词条，已解除锁定，可重试";
    };
  }

  resumeBtn.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "POC_RESUME_PLAYBACK" });
    status.textContent = res?.ok ? "已恢复播放" : `恢复失败: ${safeText(res?.error)}`;
  });

  addBtn.addEventListener("click", async () => {
    await addBtnHandler();
    if (status.textContent.includes("已保存")) {
      saved = true;
    }
  });

  if (payload?.loading) {
    const loadingWrap = createEl("div", "wb-overlay-loading");
    const spinner = createEl("div", "wb-spinner");
    const text = createEl("div", "muted", "正在识别字幕并查询词典，请稍候...");
    const cancelBtn = createEl("button", "wb-btn wb-btn-default", "取消本次");
    cancelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "POC_RELEASE_CAPTURE_LOCK" }).catch(() => {});
      removeOverlay();
    });
    loadingWrap.appendChild(spinner);
    loadingWrap.appendChild(text);
    loadingWrap.appendChild(cancelBtn);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(loadingWrap);
    card.appendChild(status);
    const pos = calcCardPosition(payload?.playback?.video_rect);
    card.style.left = `${pos.left}px`;
    card.style.top = `${pos.top}px`;
    root.appendChild(mask);
    root.appendChild(card);
    document.documentElement.appendChild(root);
    return;
  }

  closeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "POC_RELEASE_CAPTURE_LOCK" }).catch(() => {});
    removeOverlay();
  });

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(jaSection);
  card.appendChild(zhSection);
  card.appendChild(tokenSection);
  card.appendChild(actions);
  card.appendChild(status);

  const pos = calcCardPosition(payload?.playback?.video_rect);
  card.style.left = `${pos.left}px`;
  card.style.top = `${pos.top}px`;

  root.appendChild(mask);
  root.appendChild(card);
  document.documentElement.appendChild(root);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "POC_PING_OVERLAY") {
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "POC_SHOW_OVERLAY") {
    renderOverlay(message.payload || {});
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "POC_HIDE_OVERLAY") {
    removeOverlay();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

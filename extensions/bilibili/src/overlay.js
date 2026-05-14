const OVERLAY_ROOT_ID = "wordbook-overlay-root";
const OVERLAY_SIZE_KEY = "wordbook_overlay_size_v1";

function safeText(value) {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value) {
  return safeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function removeOverlay() {
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing) existing.remove();
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

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (typeof text === "string") el.textContent = text;
  return el;
}

function rehomeOverlay() {
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  const host = getOverlayHost();
  if (existing && existing.parentElement !== host) {
    host.appendChild(existing);
  }
}

function mountOverlay(root, mask, card) {
  root.replaceChildren(mask, card);
  getOverlayHost().appendChild(root);
}

document.addEventListener("fullscreenchange", rehomeOverlay);
document.addEventListener("webkitfullscreenchange", rehomeOverlay);

async function loadOverlaySize() {
  try {
    const data = await chrome.storage.local.get(OVERLAY_SIZE_KEY);
    const size = data?.[OVERLAY_SIZE_KEY] || {};
    const width = Number(size.width || 0);
    const height = Number(size.height || 0);
    return {
      width: width >= 420 ? width : null,
      height: height >= 360 ? height : null
    };
  } catch {
    return { width: null, height: null };
  }
}

function saveOverlaySize(width, height) {
  chrome.storage.local.set({
    [OVERLAY_SIZE_KEY]: {
      width: Math.round(width),
      height: Math.round(height)
    }
  }).catch(() => {});
}

function installResizeHandles(card) {
  const handles = [
    ["right", "wb-overlay-resize-handle wb-overlay-resize-right"],
    ["bottom", "wb-overlay-resize-handle wb-overlay-resize-bottom"],
    ["corner", "wb-overlay-resize-handle wb-overlay-resize-corner"]
  ];
  handles.forEach(([dir, className]) => {
    const handle = createEl("div", className);
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = card.offsetWidth;
      const startHeight = card.offsetHeight;
      const onMove = (moveEvent) => {
        const maxWidth = Math.max(420, window.innerWidth - 32);
        const maxHeight = Math.max(360, window.innerHeight - 32);
        if (dir === "right" || dir === "corner") {
          const nextWidth = Math.max(420, Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
          card.style.width = `${nextWidth}px`;
        }
        if (dir === "bottom" || dir === "corner") {
          const nextHeight = Math.max(360, Math.min(maxHeight, startHeight + moveEvent.clientY - startY));
          card.style.height = `${nextHeight}px`;
          card.style.maxHeight = "none";
        }
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        saveOverlaySize(card.offsetWidth, card.offsetHeight);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
    card.appendChild(handle);
  });
}

async function lookupMeaning(candidates) {
  const seen = new Set();
  const keys = (Array.isArray(candidates) ? candidates : [candidates])
    .map((value) => safeText(value).trim())
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });

  for (const lemma of keys) {
    const res = await chrome.runtime.sendMessage({
      type: "POC_DICT_LOOKUP",
      lemma
    });
    if (res?.ok && res.result?.meanings?.length) return res.result;
  }
  return null;
}

async function renderOverlay(payload) {
  const root = document.getElementById(OVERLAY_ROOT_ID) || createEl("div", "wb-overlay-root");
  root.id = OVERLAY_ROOT_ID;
  root.className = "wb-overlay-root";
  const mask = createEl("div", "wb-overlay-mask");
  const card = createEl("div", "wb-overlay-card");
  const savedSize = await loadOverlaySize();
  if (savedSize.width) card.style.width = `${Math.min(savedSize.width, window.innerWidth - 32)}px`;
  if (savedSize.height) {
    const capped = Math.min(savedSize.height, window.innerHeight - 32);
    card.style.height = `${Math.max(360, capped)}px`;
  }
  installResizeHandles(card);

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

  let hasPartnerFromSpace = false;
  let partnerUsername = "";
  try {
    const partnerRes = await chrome.runtime.sendMessage({ type: "POC_GET_SPACE_PARTNER" });
    if (partnerRes?.ok) {
      hasPartnerFromSpace = Boolean(partnerRes.has_partner);
      partnerUsername = safeText(partnerRes.partner_username);
    }
  } catch {
    hasPartnerFromSpace = false;
  }

  const moreToggle = createEl("button", "wb-btn wb-btn-default wb-overlay-more-toggle", "更多 ▼");
  moreToggle.type = "button";
  const extrasBody = createEl("div", "wb-overlay-extras-body");
  extrasBody.style.display = "none";

  const tagSection = createEl("div", "wb-overlay-section");
  tagSection.appendChild(createEl("div", "wb-overlay-label", "句子 tag"));
  const tagChoices = ["kksk", "好搞笑", "高频词", "神台词", "听力"];
  const selectedTags = new Set();
  const tagList = createEl("div", "wb-overlay-tag-list");
  const tagAddRow = createEl("div", "wb-overlay-tag-add-row");
  const tagInput = createEl("input", "wb-overlay-meaning-input");
  tagInput.placeholder = "添加自定义 tag";
  const tagAddBtn = createEl("button", "wb-btn wb-btn-default", "添加");
  const getTags = () => Array.from(selectedTags);
  const renderTagButtons = () => {
    tagList.innerHTML = "";
    tagChoices.forEach((tag) => {
      const btn = createEl("button", `wb-overlay-tag-chip${selectedTags.has(tag) ? " active" : ""}`, tag);
      btn.type = "button";
      btn.addEventListener("click", () => {
        if (selectedTags.has(tag)) selectedTags.delete(tag);
        else selectedTags.add(tag);
        renderTagButtons();
      });
      tagList.appendChild(btn);
    });
  };
  tagAddBtn.addEventListener("click", () => {
    const value = safeText(tagInput.value).trim();
    if (!value) return;
    if (!tagChoices.includes(value)) tagChoices.push(value);
    selectedTags.add(value);
    tagInput.value = "";
    renderTagButtons();
  });
  tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      tagAddBtn.click();
    }
  });
  renderTagButtons();
  tagAddRow.appendChild(tagInput);
  tagAddRow.appendChild(tagAddBtn);
  tagSection.appendChild(tagList);
  tagSection.appendChild(tagAddRow);

  const shareSection = createEl("div", "wb-overlay-section wb-overlay-share-row");
  const shareCheck = createEl("input");
  shareCheck.type = "checkbox";
  shareCheck.id = "wb-overlay-share-partner";
  shareCheck.disabled = !hasPartnerFromSpace;
  const shareLabelWrap = createEl("label", "wb-overlay-share-label");
  shareLabelWrap.appendChild(shareCheck);
  shareLabelWrap.appendChild(
    createEl(
      "span",
      "",
      hasPartnerFromSpace
        ? `同时分享给我的搭子${partnerUsername ? ` (@${partnerUsername})` : ""}`
        : "同时分享给我的搭子（未绑定搭子时不可用）"
    )
  );
  shareSection.appendChild(shareLabelWrap);
  const partnerCommentInput = createEl("textarea", "wb-overlay-textarea wb-overlay-partner-comment");
  partnerCommentInput.placeholder = "给搭子的留言（可选）";
  partnerCommentInput.disabled = true;
  shareCheck.addEventListener("change", () => {
    partnerCommentInput.disabled = !shareCheck.checked;
  });
  shareSection.appendChild(partnerCommentInput);

  extrasBody.appendChild(tagSection);
  extrasBody.appendChild(shareSection);

  moreToggle.addEventListener("click", () => {
    const open = extrasBody.style.display === "none";
    extrasBody.style.display = open ? "flex" : "none";
    moreToggle.textContent = open ? "更多 ▲" : "更多 ▼";
  });

  const moreWrap = createEl("div", "wb-overlay-section wb-overlay-more-wrap");
  moreWrap.appendChild(moreToggle);
  moreWrap.appendChild(extrasBody);

  const tokenSection = createEl("div", "wb-overlay-section");
  tokenSection.appendChild(createEl("div", "wb-overlay-label", "选择字符/词片段（可多选，自动拼接）"));
  const tokenList = createEl("div", "wb-overlay-token-list");
  let tokens = Array.isArray(payload?.tokens) ? [...payload.tokens] : [];
  const selectedIndices = new Set();
  if (tokens.length > 0) selectedIndices.add(0);
  let addBtnHandler = async () => {};

  if (tokens.length === 0) {
    tokenList.appendChild(createEl("div", "", "未识别到可用日语分词。"));
    let initialRetokenizeTimer = 0;
    jaTextarea.addEventListener("input", () => {
      window.clearTimeout(initialRetokenizeTimer);
      initialRetokenizeTimer = window.setTimeout(async () => {
        const text = safeText(jaTextarea.value).trim();
        if (!text) return;
        tokenList.innerHTML = "";
        tokenList.appendChild(createEl("div", "", "重新分词中..."));
        try {
          const res = await chrome.runtime.sendMessage({ type: "POC_TOKENIZE_TEXT", text });
          const nextTokens = Array.isArray(res?.tokens) ? res.tokens : [];
          if (!nextTokens.length) {
            tokenList.innerHTML = "";
            tokenList.appendChild(createEl("div", "", "未识别到可用日语分词。"));
            return;
          }
          await renderOverlay({
            ...payload,
            ocr: {
              ...(payload?.ocr || {}),
              ja_lines: [text],
              zh_lines: [safeText(zhTextarea.value)]
            },
            tokens: nextTokens
          });
        } catch {
          tokenList.innerHTML = "";
          tokenList.appendChild(createEl("div", "", "重新分词失败。"));
        }
      }, 420);
    });
  } else {
    const dictPreview = createEl("div", "wb-overlay-dict-preview wb-overlay-dict-panel");
    dictPreview.innerHTML = '<span class="muted">词典查询结果将显示在这里</span>';
    const readingHint = createEl("div", "wb-overlay-reading-hint muted", "");

    const composedWordInput = createEl("input", "wb-overlay-meaning-input");
    composedWordInput.placeholder = "词形（由上方勾选自动填入，也可手改）";
    let composedEdited = false;

    const meaningInput = createEl("textarea", "wb-overlay-textarea wb-overlay-meaning-textarea");
    meaningInput.placeholder = "释义（选词后会自动填入词典结果，可多行或用；分隔多条）";
    let meaningEdited = false;
    meaningInput.addEventListener("input", () => {
      meaningEdited = true;
    });

    let lookupSeq = 0;
    let lookupReading = "";
    let lookupDict = null;

    const parseMeaningsField = () =>
      meaningInput.value
        .split(/[\n;；]/)
        .map((s) => safeText(s).trim())
        .filter(Boolean);

    function applyDictMeaningsToField(dict) {
      if (meaningEdited) return;
      if (dict?.meanings?.length) {
        meaningInput.value = dict.meanings.join("；");
      } else {
        meaningInput.value = "";
      }
    }

    composedWordInput.addEventListener("input", () => {
      composedEdited = true;
      refreshDictionaryPreview().catch(() => {});
    });

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

    const getComposedJlptLevel = () =>
      Array.from(selectedIndices)
        .sort((a, b) => a - b)
        .map((idx) => safeText(tokens[idx]?.jlpt_level))
        .filter(Boolean)
        .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0] || "";

    const refreshDictionaryPreview = async () => {
      const typedWord = composedWordInput.value.trim();
      const surfaceText = getComposedTokenText();
      const dictionaryForm = getComposedDictionaryForm();
      const lookupCandidates = composedEdited && typedWord ? [typedWord, surfaceText, dictionaryForm] : [surfaceText, dictionaryForm, typedWord];
      if (!lookupCandidates.some((value) => safeText(value).trim())) {
        lookupReading = "";
        lookupDict = null;
        readingHint.textContent = "";
        dictPreview.innerHTML = '<span class="muted">词典查询结果将显示在这里</span>';
        meaningEdited = false;
        meaningInput.value = "";
        return;
      }

      const seq = ++lookupSeq;
      dictPreview.innerHTML = '<span class="muted">词典查询中...</span>';
      const dict = await lookupMeaning(lookupCandidates);
      if (seq !== lookupSeq) return;

      if (dict?.meanings?.length) {
        lookupDict = dict;
        lookupReading = safeText(dict?.reading);
        readingHint.textContent = [safeText(dict?.reading), safeText(dict?.jlpt_level) || getComposedJlptLevel()].filter(Boolean).join(" · ");
        dictPreview.innerHTML = `
          <div class="wb-dict-panel-title">${escapeHtml(dict.lemma)}</div>
          <div><strong>词典释义</strong>：${dict.meanings.map((m) => escapeHtml(m)).join("；")}</div>
        `;
      } else {
        lookupReading = "";
        lookupDict = null;
        readingHint.textContent = getComposedJlptLevel();
        dictPreview.innerHTML = '<span class="muted">未命中在线词典结果，可自行填写释义</span>';
      }
      applyDictMeaningsToField(dict);
    };

    const refreshBubbleState = async () => {
      meaningEdited = false;
      composedEdited = false;
      Array.from(tokenList.querySelectorAll(".wb-overlay-token-bubble")).forEach((btn, idx) => {
        btn.classList.toggle("active", selectedIndices.has(idx));
      });
      composedWordInput.value = getComposedTokenText();
      await refreshDictionaryPreview();
    };

    const renderTokenBubbles = () => {
      tokenList.innerHTML = "";
      if (!tokens.length) {
        tokenList.appendChild(createEl("div", "", "未识别到可用日语分词。"));
        return;
      }
      tokens.forEach((token, index) => {
        const bubble = createEl(
          "button",
          `wb-overlay-token-bubble${selectedIndices.has(index) ? " active" : ""}`,
          ""
        );
        bubble.type = "button";
        const level = safeText(token.jlpt_level);
        const dictionaryForm = safeText(token.dictionary_form || token.surface);
        const surfaceText = safeText(token.surface);
        bubble.title = [surfaceText, dictionaryForm !== surfaceText ? dictionaryForm : "", level].filter(Boolean).join(" · ");
        const tokenMain = createEl("span", "wb-overlay-token-main");
        const tokenMainText = createEl("span", "wb-overlay-token-main-text");
        tokenMainText.appendChild(createEl("span", "wb-overlay-token-surface", surfaceText));
        tokenMain.appendChild(tokenMainText);
        bubble.appendChild(tokenMain);
        if (dictionaryForm && dictionaryForm !== surfaceText) {
          const tokenMeta = createEl("span", "wb-overlay-token-meta");
          tokenMeta.textContent = dictionaryForm;
          bubble.appendChild(tokenMeta);
        }
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
    };

    let retokenizeTimer = 0;
    let retokenizeSeq = 0;
    const retokenizeFromTextarea = () => {
      window.clearTimeout(retokenizeTimer);
      retokenizeTimer = window.setTimeout(async () => {
        const text = safeText(jaTextarea.value).trim();
        const seq = ++retokenizeSeq;
        if (!text) {
          tokens = [];
          selectedIndices.clear();
          renderTokenBubbles();
          await refreshBubbleState();
          return;
        }
        tokenList.classList.add("loading");
        try {
          const res = await chrome.runtime.sendMessage({ type: "POC_TOKENIZE_TEXT", text });
          if (seq !== retokenizeSeq) return;
          tokens = Array.isArray(res?.tokens) ? res.tokens : [];
          selectedIndices.clear();
          if (tokens.length) selectedIndices.add(0);
          renderTokenBubbles();
          await refreshBubbleState();
        } catch {
          if (seq === retokenizeSeq) {
            tokenList.innerHTML = "";
            tokenList.appendChild(createEl("div", "", "重新分词失败。"));
          }
        } finally {
          tokenList.classList.remove("loading");
        }
      }, 420);
    };
    jaTextarea.addEventListener("input", retokenizeFromTextarea);

    renderTokenBubbles();
    refreshBubbleState().catch(() => {});
    tokenSection.appendChild(tokenList);

    tokenSection.appendChild(createEl("div", "wb-overlay-label", "词典查询"));
    tokenSection.appendChild(dictPreview);
    tokenSection.appendChild(readingHint);
    tokenSection.appendChild(createEl("div", "wb-overlay-label", "词形"));
    tokenSection.appendChild(composedWordInput);
    tokenSection.appendChild(createEl("div", "wb-overlay-label", "释义（保存到词典）"));
    tokenSection.appendChild(meaningInput);

    addBtnHandler = async () => {
      status.textContent = "保存中...";
      if (!selectedIndices.size) {
        status.textContent = "请至少选择一个字符/词片段";
        return;
      }
      const composedSurface = safeText(composedWordInput.value).trim() || getComposedTokenText();
      const composedDictionaryForm = getComposedDictionaryForm() || composedSurface;
      const composedReading = lookupReading || getComposedReading();
      const composedJlptLevel = safeText(lookupDict?.jlpt_level) || getComposedJlptLevel();
      let composedMeanings = parseMeaningsField();
      if (!composedMeanings.length && lookupDict?.meanings?.length) {
        composedMeanings = [...lookupDict.meanings];
      }
      const tags = getTags();
      const words = [
        {
          surface: composedSurface,
          dictionary_form: composedDictionaryForm,
          reading: composedReading,
          jlpt_level: composedJlptLevel,
          source: "manual",
          meanings: composedMeanings,
          skip_enrichment: true,
          example_ja: safeText(jaTextarea.value),
          example_zh: safeText(zhTextarea.value),
          tags,
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
        words,
        share_to_partner: Boolean(hasPartnerFromSpace && shareCheck.checked),
        partner_comment: safeText(partnerCommentInput.value)
      });
      if (!saveRes?.ok) {
        status.textContent = `保存失败: ${safeText(saveRes?.error)}`;
        return;
      }
      let msg = Number(saveRes.created_count || 0) > 0 ? "已保存 1 个词" : "已跳过重复词条";
      if (saveRes.share_error) msg += `（分享：${safeText(saveRes.share_error)}）`;
      status.textContent = msg;
    };
  }
  if (tokens.length === 0) {
    tokenSection.appendChild(tokenList);
  }

  const actions = createEl("div", "wb-overlay-actions");
  const addBtn = createEl("button", "wb-btn wb-btn-primary", "添加到词典");
  const sentenceBtn = createEl("button", "wb-btn wb-btn-default", "只保存句子");
  const closeBtn = createEl("button", "wb-btn wb-btn-default", "关闭窗口");
  const resumeBtn = createEl("button", "wb-btn wb-btn-default", "恢复播放");
  actions.appendChild(addBtn);
  actions.appendChild(sentenceBtn);
  actions.appendChild(closeBtn);
  actions.appendChild(resumeBtn);
  if (!tokens.length) {
    addBtn.disabled = true;
    addBtn.title = "未识别到可添加词条";
  }

  const status = createEl("div", "wb-overlay-status");
  let saved = false;
  if (!tokens.length) {
    addBtnHandler = async () => {
      status.textContent = "未识别到可添加词条";
    };
  }

  resumeBtn.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "POC_RESUME_PLAYBACK" });
    status.textContent = res?.ok ? "已恢复播放" : `恢复失败: ${safeText(res?.error)}`;
    if (res?.ok) removeOverlay();
  });

  addBtn.addEventListener("click", async () => {
    await addBtnHandler();
    if (status.textContent.includes("已保存")) {
      saved = true;
    }
  });

  sentenceBtn.addEventListener("click", async () => {
    status.textContent = "保存句子中...";
    const tags = getTags();
    try {
      const res = await chrome.runtime.sendMessage({
        type: "POC_ADD_SENTENCE_ONLY",
        sentence: {
          example_ja: safeText(jaTextarea.value),
          example_zh: safeText(zhTextarea.value),
          tags,
          screenshot_base64: safeText(payload?.screenshot_base64) || null,
          playback: payload?.playback || null
        },
        share_to_partner: Boolean(hasPartnerFromSpace && shareCheck.checked),
        partner_comment: safeText(partnerCommentInput.value)
      });
      status.textContent = res?.ok
        ? res.share_error
          ? `句子已保存（分享未完成：${safeText(res.share_error)}）`
          : "句子已保存"
        : `保存失败: ${safeText(res?.error)}`;
      if (res?.ok) saved = true;
    } catch (error) {
      status.textContent = `保存失败: ${safeText(error?.message || error)}`;
    }
  });

  if (payload?.loading) {
    const loadingWrap = createEl("div", "wb-overlay-loading");
    const spinner = createEl("div", "wb-spinner");
    const stepText = safeText(payload?.loading_step) || "正在识别字幕";
    const text = createEl("div", "wb-overlay-loading-step", stepText);
    const detail = createEl("div", "muted", safeText(payload?.loading_detail) || "请稍候...");
    const cancelBtn = createEl("button", "wb-btn wb-btn-default", "关闭窗口");
    cancelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "POC_RELEASE_CAPTURE_LOCK" }).catch(() => {});
      removeOverlay();
    });
    loadingWrap.appendChild(spinner);
    loadingWrap.appendChild(text);
    loadingWrap.appendChild(detail);

    const cardHeaderLoading = createEl("div", "wb-overlay-card-header");
    cardHeaderLoading.appendChild(title);
    cardHeaderLoading.appendChild(meta);

    const cardScrollLoading = createEl("div", "wb-overlay-card-scroll");
    cardScrollLoading.appendChild(loadingWrap);

    const loadingActions = createEl("div", "wb-overlay-actions");
    loadingActions.appendChild(cancelBtn);

    const cardFooterLoading = createEl("div", "wb-overlay-card-footer");
    cardFooterLoading.appendChild(loadingActions);
    cardFooterLoading.appendChild(status);

    card.appendChild(cardHeaderLoading);
    card.appendChild(cardScrollLoading);
    card.appendChild(cardFooterLoading);

    mountOverlay(root, mask, card);
    return;
  }

  closeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "POC_RELEASE_CAPTURE_LOCK" }).catch(() => {});
    removeOverlay();
  });

  const cardHeader = createEl("div", "wb-overlay-card-header");
  cardHeader.appendChild(title);
  cardHeader.appendChild(meta);

  const cardScroll = createEl("div", "wb-overlay-card-scroll");
  cardScroll.appendChild(jaSection);
  cardScroll.appendChild(zhSection);
  cardScroll.appendChild(moreWrap);
  cardScroll.appendChild(tokenSection);

  const cardFooter = createEl("div", "wb-overlay-card-footer");
  cardFooter.appendChild(actions);
  cardFooter.appendChild(status);

  card.appendChild(cardHeader);
  card.appendChild(cardScroll);
  card.appendChild(cardFooter);

  mountOverlay(root, mask, card);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "POC_PING_OVERLAY") {
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "POC_SHOW_OVERLAY") {
    renderOverlay(message.payload || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: safeText(error?.message || error) }));
    return true;
  }
  if (message?.type === "POC_HIDE_OVERLAY") {
    removeOverlay();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

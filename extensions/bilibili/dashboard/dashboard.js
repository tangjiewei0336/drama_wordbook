const BASE = "http://127.0.0.1:17321";

const state = {
  view: "byPlayer",
  playerNodes: [],
  timeItems: [],
  selectedItems: [],
  search: ""
};

const els = {
  byPlayerBtn: document.getElementById("viewByPlayer"),
  byTimeBtn: document.getElementById("viewByTime"),
  refreshBtn: document.getElementById("refreshBtn"),
  searchInput: document.getElementById("searchInput"),
  leftPanel: document.getElementById("leftPanel"),
  detailPanel: document.getElementById("detailPanel"),
  dictSection: document.getElementById("dictSection"),
  gallerySection: document.getElementById("gallerySection"),
  lightbox: document.getElementById("lightbox"),
  lightboxMask: document.getElementById("lightboxMask"),
  lightboxImg: document.getElementById("lightboxImg"),
  error: document.getElementById("error")
};

function setError(message) {
  els.error.textContent = message || "";
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`请求失败: ${res.status}`);
  }
  return res.json();
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || "";
  }
}

async function fetchHeadItems(headId) {
  return getJson(`/vocab/heads/${headId}/items`);
}

async function loadData() {
  setError("");
  try {
    const [nodes, byTime] = await Promise.all([
      getJson("/vocab/view/by-player"),
      getJson("/vocab/view/by-time")
    ]);
    state.playerNodes = Array.isArray(nodes) ? nodes : [];
    state.timeItems = Array.isArray(byTime?.items) ? byTime.items : [];
    renderLeft();
    renderDetail();
  } catch (error) {
    setError(String(error?.message || error));
  }
}

function renderLeft() {
  els.leftPanel.innerHTML = "";
  if (state.view === "byPlayer") {
    const container = document.createElement("div");
    container.className = "tree";
    state.playerNodes.forEach((node, idx) => {
      const grouped = new Map();
      (node.items || []).forEach((item) => {
        const arr = grouped.get(item.head_id) || [];
        arr.push(item);
        grouped.set(item.head_id, arr);
      });

      const nodeEl = document.createElement("div");
      nodeEl.className = "tree-node";
      const label = document.createElement("div");
      label.className = "tree-label";
      label.textContent = `${node.platform} / ${node.series_name} / ${node.episode_name}`;
      nodeEl.appendChild(label);

      const actions = document.createElement("div");
      actions.className = "tree-actions";
      for (const [headId, items] of grouped.entries()) {
        const chip = document.createElement("button");
        chip.className = "chip";
        chip.textContent = `${items[0]?.surface || "词条"} (${items.length})`;
        chip.addEventListener("click", async () => {
          state.selectedItems = await fetchHeadItems(headId);
          renderDetail();
        });
        actions.appendChild(chip);
      }
      nodeEl.appendChild(actions);
      container.appendChild(nodeEl);
    });
    els.leftPanel.appendChild(container);
    return;
  }

  const q = state.search.trim().toLowerCase();
  const list = q
    ? state.timeItems.filter((item) =>
        [item.surface, item.reading, (item.meanings || []).join(" "), item.example_ja]
          .join(" ")
          .toLowerCase()
          .includes(q)
      )
    : state.timeItems;

  const container = document.createElement("div");
  container.className = "tree";
  list.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = "time-item";
    btn.innerHTML = `<span>${item.surface || ""}</span><span class="muted">${formatDate(item.created_at)}</span>`;
    btn.addEventListener("click", async () => {
      state.selectedItems = await fetchHeadItems(item.head_id);
      renderDetail();
    });
    container.appendChild(btn);
  });
  els.leftPanel.appendChild(container);
}

function renderDetail() {
  if (!state.selectedItems.length) {
    els.dictSection.innerHTML = '<div class="muted">请选择左侧节点查看词典释义</div>';
    els.gallerySection.innerHTML = '<div class="muted">选择后会在这里展示剧照瀑布流</div>';
    return;
  }
  const first = state.selectedItems[0];
  const meanings = Array.from(
    new Set(
      state.selectedItems.flatMap((x) => (Array.isArray(x.meanings) ? x.meanings : [])).map((x) => String(x).trim())
    )
  ).filter(Boolean);
  const reading = first?.reading || "";
  const title = first?.surface || "词条";

  els.dictSection.innerHTML = `
    <div class="dict-title">${title}</div>
    <div class="dict-sub">${reading ? `读音: ${reading}` : "读音: -"} · 实例数: ${state.selectedItems.length}</div>
    ${
      meanings.length
        ? `<ol class="dict-meanings">${meanings.map((m) => `<li>${m}</li>`).join("")}</ol>`
        : '<div class="muted">暂无词典释义</div>'
    }
  `;

  const shots = state.selectedItems.filter((x) => x.screenshot_path);
  if (!shots.length) {
    els.gallerySection.innerHTML = '<div class="muted">暂无剧照</div>';
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "waterfall";
  shots.forEach((item) => {
    const screenshotUrl = `${BASE}/vocab/items/${item.id}/screenshot`;
    const node = document.createElement("div");
    node.className = "shot";
    node.innerHTML = `
      <img src="${screenshotUrl}" alt="screenshot-${item.id}" loading="lazy" />
      <div class="shot-meta">
        <span>${formatDate(item.created_at)}</span>
        ${
          item?.playback?.url
            ? `<a href="${item.playback.url}" target="_blank" rel="noreferrer">跳转 ${Number(item.playback.current_time || 0).toFixed(1)}s</a>`
            : ""
        }
        <a href="${screenshotUrl}" target="_blank" rel="noreferrer">查看原图</a>
      </div>
    `;
    const img = node.querySelector("img");
    img?.addEventListener("click", () => {
      els.lightboxImg.src = screenshotUrl;
      els.lightbox.classList.remove("hidden");
    });
    wrap.appendChild(node);
  });
  els.gallerySection.innerHTML = "";
  els.gallerySection.appendChild(wrap);
}

els.byPlayerBtn.addEventListener("click", () => {
  state.view = "byPlayer";
  els.byPlayerBtn.classList.add("active");
  els.byTimeBtn.classList.remove("active");
  renderLeft();
});

els.byTimeBtn.addEventListener("click", () => {
  state.view = "byTime";
  els.byPlayerBtn.classList.remove("active");
  els.byTimeBtn.classList.add("active");
  renderLeft();
});

els.searchInput.addEventListener("input", (e) => {
  state.search = e.target.value || "";
  if (state.view === "byTime") renderLeft();
});

els.refreshBtn.addEventListener("click", loadData);

els.lightboxMask.addEventListener("click", () => {
  els.lightbox.classList.add("hidden");
  els.lightboxImg.src = "";
});

loadData();

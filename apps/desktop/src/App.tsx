import {
  BookOpen,
  CalendarClock,
  ChevronDown,
  Clapperboard,
  Cpu,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Save,
  MessageSquareText,
  Pencil,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAsrStatus,
  deletePlayerGroup,
  deleteVocabItem,
  fetchByPlayer,
  fetchByTime,
  fetchHeadItems,
  fetchHealth,
  lookupDictionary,
  screenshotUrl,
  SIDECAR_BASE,
  startAsrModelLoad,
  tokenizeJapanese,
  updateVocabItemText,
  type AsrModelStatus,
  type DictLookupResult,
  type HealthStatus,
  type JaToken,
  type PlayerNode,
  type SidecarProcessStatus,
  type VocabItem,
} from "./api";
import "./styles.css";

type ViewMode = "byPlayer" | "byTime";
type MainMode = ViewMode | "sentences" | "runtime";
type SelectedSource = Pick<PlayerNode, "platform" | "source" | "series_name" | "episode_name" | "items"> | null;
type LogEntry = { id: string; at: string; level: string; source: string; message: string };
type SentenceGroup = {
  key: string;
  text: string;
  zh: string;
  items: VocabItem[];
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatTime(seconds = 0): string {
  const safe = Math.max(0, Number(seconds || 0));
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes = 0): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

function uniqueMeanings(items: VocabItem[]): string[] {
  return Array.from(
    new Set(items.flatMap((item) => item.meanings || []).map((item) => String(item).trim()).filter(Boolean))
  );
}

function detailKey(item: VocabItem): string {
  return `${item.id}-${item.head_id}`;
}

function sourceKey(node: Pick<PlayerNode, "platform" | "source" | "series_name" | "episode_name">): string {
  return `${node.platform}::${node.source || "manual"}::${node.series_name}::${node.episode_name}`;
}

function sourceLabel(source = "manual"): string {
  return source === "auto" ? "自动保存" : "手动保存";
}

function hasKanji(text = ""): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function toHiragana(text = ""): string {
  return text.replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function posClass(pos = ""): string {
  if (pos.includes("名词")) return "pos-noun";
  if (pos.includes("动词")) return "pos-verb";
  if (pos.includes("形容")) return "pos-adj";
  if (pos.includes("助词") || pos.includes("助动词")) return "pos-particle";
  if (pos.includes("副词")) return "pos-adv";
  return "pos-other";
}

function normalizeSentenceText(item: VocabItem): string {
  return (item.example_ja || item.surface || "").trim();
}

async function openExternal(url: string) {
  if (window.wordbookDesktop?.openExternal) {
    await window.wordbookDesktop.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noreferrer");
}

export default function App() {
  const [view, setView] = useState<MainMode>("byPlayer");
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const wasHealthyRef = useRef(false);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarProcessStatus | null>(null);
  const [asrStatus, setAsrStatus] = useState<AsrModelStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [playerNodes, setPlayerNodes] = useState<PlayerNode[]>([]);
  const [timeItems, setTimeItems] = useState<VocabItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<VocabItem[]>([]);
  const [selectedHeadId, setSelectedHeadId] = useState<number | null>(null);
  const [selectedSource, setSelectedSource] = useState<SelectedSource>(null);
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(new Set());
  const [selectedSentenceId, setSelectedSentenceId] = useState<number | null>(null);
  const [selectedSentenceKey, setSelectedSentenceKey] = useState("");
  const [sentenceJa, setSentenceJa] = useState("");
  const [sentenceZh, setSentenceZh] = useState("");
  const [sentenceTokens, setSentenceTokens] = useState<JaToken[]>([]);
  const [selectedTokenLookup, setSelectedTokenLookup] = useState<DictLookupResult | null>(null);
  const [sentenceBusy, setSentenceBusy] = useState(false);
  const [editingSentence, setEditingSentence] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const isSidecarOnline = Boolean(sidecarStatus?.healthy || health);
  const serviceText = sidecarStatus
    ? sidecarStatus.healthy
      ? sidecarStatus.managed
        ? `Sidecar 在线 · PID ${sidecarStatus.pid}`
        : "Sidecar 在线 · 外部进程"
      : sidecarStatus.state === "starting" || sidecarStatus.state === "restarting"
        ? "Sidecar 启动中"
        : "Sidecar 离线"
    : health
      ? "Sidecar 在线"
      : "Sidecar 检测中";

  async function loadAll(keepSelection = true) {
    setLoading(true);
    setError("");
    try {
      const [healthRes, nodes, timeList] = await Promise.all([fetchHealth(), fetchByPlayer(), fetchByTime()]);
      setHealth(healthRes);
      if (healthRes.asr) setAsrStatus(healthRes.asr);
      setPlayerNodes(nodes);
      setTimeItems(timeList);

      if (keepSelection && selectedHeadId) {
        setSelectedItems(await fetchHeadItems(selectedHeadId));
      } else if (!keepSelection) {
        setSelectedItems([]);
        setSelectedHeadId(null);
        setSelectedSource(null);
      }
    } catch (err) {
      setHealth(null);
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    window.wordbookDesktop?.getSidecarStatus?.().then((status) => {
      if (!disposed) setSidecarStatus(status as SidecarProcessStatus);
    });
    const off = window.wordbookDesktop?.onSidecarStatus?.((status) => {
      setSidecarStatus(status as SidecarProcessStatus);
      if (status.healthy && !wasHealthyRef.current) {
        loadAll(true);
      }
      wasHealthyRef.current = Boolean(status.healthy);
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [selectedHeadId]);

  useEffect(() => {
    window.wordbookDesktop?.getSidecarLogs?.().then((items) => setLogs(items as LogEntry[]));
    const off = window.wordbookDesktop?.onSidecarLog?.((entry) => {
      setLogs((items) => [...items, entry as LogEntry].slice(-800));
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    if (view !== "runtime" || !isSidecarOnline) return;
    fetchAsrStatus().then(setAsrStatus).catch(() => {});
    const timer = window.setInterval(() => {
      fetchAsrStatus().then(setAsrStatus).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [view, isSidecarOnline]);

  useEffect(() => {
    if (!selectedSource?.items.length) return;
    const timer = window.setInterval(() => {
      setCarouselIndex((value) => value + 1);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [selectedSource]);

  const filteredTimeItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return timeItems;
    return timeItems.filter((item) =>
      [item.surface, item.reading, item.meanings.join(" "), item.example_ja, item.example_zh, item.playback?.title]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [timeItems, search]);

  const selectedTitle = selectedItems[0]?.surface || "未选择词条";
  const selectedMeanings = uniqueMeanings(selectedItems);
  const sourceStats = useMemo(() => {
    const items = selectedSource?.items || [];
    return {
      words: new Set(items.map((item) => item.head_id)).size,
      examples: items.length,
      screenshots: items.filter((item) => item.screenshot_path).length,
      latestTime: Math.max(...items.map((item) => Number(item.playback?.current_time || 0)), 0),
    };
  }, [selectedSource]);
  const carouselItems = useMemo(
    () => (selectedSource?.items || []).filter((item) => item.screenshot_path),
    [selectedSource]
  );
  const carouselItem = carouselItems.length ? carouselItems[carouselIndex % carouselItems.length] : null;
  const selectedSentence = useMemo(
    () => timeItems.find((item) => item.id === selectedSentenceId) || null,
    [timeItems, selectedSentenceId]
  );
  const knownWordKeys = useMemo(() => {
    const keys = new Set<string>();
    timeItems.forEach((item) => {
      if (item.surface) keys.add(item.surface);
      if (item.surface && item.surface.length > 1) keys.add(item.surface);
      if (item.dictionary_form) keys.add(item.dictionary_form);
      if (item.reading) keys.add(item.reading);
      if (item.example_ja) keys.add(item.example_ja);
    });
    return keys;
  }, [timeItems]);
  const knownSentenceWords = useMemo(
    () =>
      Array.from(new Set(timeItems.flatMap((item) => [item.surface, item.dictionary_form]).filter(Boolean)))
        .map(String)
        .filter((word) => word.length > 0)
        .sort((a, b) => b.length - a.length),
    [timeItems]
  );
  const sentenceGroups = useMemo<SentenceGroup[]>(() => {
    const groups = new Map<string, SentenceGroup>();
    filteredTimeItems.forEach((item) => {
      const text = normalizeSentenceText(item);
      if (!text) return;
      const source = item.playback?.url || item.playback?.title || "";
      const key = `${text}::${source}`;
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(item);
        if (!existing.zh && item.example_zh) existing.zh = item.example_zh;
      } else {
        groups.set(key, {
          key,
          text,
          zh: item.example_zh || "",
          items: [item],
        });
      }
    });
    return Array.from(groups.values()).sort((a, b) => {
      const aTime = Math.max(...a.items.map((item) => new Date(item.created_at).getTime()));
      const bTime = Math.max(...b.items.map((item) => new Date(item.created_at).getTime()));
      return bTime - aTime;
    });
  }, [filteredTimeItems]);

  async function onSelectHead(headId: number) {
    setLoading(true);
    setError("");
    try {
      setSelectedHeadId(headId);
      setSelectedSource(null);
      setSelectedItems(await fetchHeadItems(headId));
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  function onSelectSource(node: PlayerNode) {
    setSelectedSource(node);
    setSelectedHeadId(null);
    setSelectedItems([]);
    setCarouselIndex(0);
  }

  function toggleSourceCollapsed(node: PlayerNode) {
    const key = sourceKey(node);
    setCollapsedSources((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onDeleteSourceGroup(node: PlayerNode) {
    const label = `${sourceLabel(node.source)} · ${node.series_name} · ${node.episode_name}`;
    if (!window.confirm(`删除这一整集的${sourceLabel(node.source)}内容？\n${label}\n\n将删除 ${node.items.length} 条例句实例，无法撤销。`)) return;
    setLoading(true);
    setError("");
    try {
      await deletePlayerGroup(node);
      const [nodes, timeList] = await Promise.all([fetchByPlayer(), fetchByTime()]);
      setPlayerNodes(nodes);
      setTimeItems(timeList);
      if (selectedSource && sourceKey(selectedSource) === sourceKey(node)) {
        setSelectedSource(null);
        setCarouselIndex(0);
      }
      if (selectedHeadId) {
        const nextItems = await fetchHeadItems(selectedHeadId).catch(() => []);
        setSelectedItems(nextItems);
        if (!nextItems.length) setSelectedHeadId(null);
      }
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteExample(item: VocabItem) {
    if (!window.confirm(`删除这条例句？\n${item.example_ja || item.surface}`)) return;
    setLoading(true);
    setError("");
    try {
      await deleteVocabItem(item.id);
      const [nodes, timeList] = await Promise.all([fetchByPlayer(), fetchByTime()]);
      setPlayerNodes(nodes);
      setTimeItems(timeList);
      if (selectedHeadId) {
        const nextItems = await fetchHeadItems(selectedHeadId).catch(() => []);
        setSelectedItems(nextItems);
        if (!nextItems.length) setSelectedHeadId(null);
      }
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onRestartSidecar() {
    setError("");
    await window.wordbookDesktop?.restartSidecar?.();
    setTimeout(() => loadAll(true), 1200);
  }

  async function onStartModelLoad() {
    setError("");
    try {
      setAsrStatus(await startAsrModelLoad());
      setView("runtime");
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  }

  async function onClearLogs() {
    await window.wordbookDesktop?.clearSidecarLogs?.();
    setLogs([]);
  }

  async function analyzeSentence(text = sentenceJa) {
    const clean = text.trim();
    if (!clean) {
      setSentenceTokens([]);
      setSelectedTokenLookup(null);
      return;
    }
    setSentenceBusy(true);
    setError("");
    try {
      setSentenceTokens(await tokenizeJapanese(clean));
      setSelectedTokenLookup(null);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setSentenceBusy(false);
    }
  }

  async function onSelectSentence(item: VocabItem, groupKey = "") {
    setSelectedSentenceId(item.id);
    setSelectedSentenceKey(groupKey);
    setSentenceJa(item.example_ja || item.surface);
    setSentenceZh(item.example_zh || "");
    setEditingSentence(false);
    setSelectedHeadId(null);
    setSelectedSource(null);
    await analyzeSentence(item.example_ja || item.surface);
  }

  async function onSaveSentenceText() {
    if (!selectedSentence) return;
    setSentenceBusy(true);
    setError("");
    try {
      const updated = await updateVocabItemText(selectedSentence.id, sentenceJa, sentenceZh);
      setTimeItems((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setPlayerNodes(await fetchByPlayer());
      if (selectedSentenceKey) {
        const group = sentenceGroups.find((entry) => entry.key === selectedSentenceKey);
        if (group) {
          await Promise.all(
            group.items
              .filter((item) => item.id !== selectedSentence.id)
              .map((item) => updateVocabItemText(item.id, sentenceJa, sentenceZh).catch(() => null))
          );
          const [nodes, timeList] = await Promise.all([fetchByPlayer(), fetchByTime()]);
          setPlayerNodes(nodes);
          setTimeItems(timeList);
        }
      }
      setEditingSentence(false);
      await analyzeSentence(sentenceJa);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setSentenceBusy(false);
    }
  }

  async function onLookupToken(token: JaToken) {
    const lemma = token.dictionary_form || token.surface;
    if (!lemma) return;
    setSentenceBusy(true);
    setError("");
    try {
      setSelectedTokenLookup(await lookupDictionary(lemma));
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setSentenceBusy(false);
    }
  }

  function isKnownToken(token: JaToken) {
    return knownWordKeys.has(token.surface) || knownWordKeys.has(token.dictionary_form);
  }

  function renderHighlightedSentence(text: string) {
    const parts: Array<{ text: string; known: boolean }> = [];
    let i = 0;
    while (i < text.length) {
      const match = knownSentenceWords.find((word) => word && text.startsWith(word, i));
      if (match) {
        parts.push({ text: match, known: true });
        i += match.length;
      } else {
        parts.push({ text: text[i], known: false });
        i += 1;
      }
    }
    return parts.map((part, idx) =>
      part.known ? <strong key={`${part.text}-${idx}`}>{part.text}</strong> : <span key={`${part.text}-${idx}`}>{part.text}</span>
    );
  }

  function renderSentenceList() {
    if (!sentenceGroups.length) {
      return <div className="empty">暂无句子。保存词条后会自动出现。</div>;
    }
    return (
      <div className="timeline">
        {sentenceGroups.map((group) => {
          const primary = group.items.find((item) => item.screenshot_path) || group.items[0];
          return (
            <button
              key={group.key}
              className={`timeline-item sentence-list-item ${selectedSentenceKey === group.key ? "active" : ""}`}
              onClick={() => onSelectSentence(primary, group.key)}
            >
              <span className="timeline-word sentence-title">{renderHighlightedSentence(group.text)}</span>
              <span className="timeline-meta">
                {group.items.length} 词 · {primary.playback?.title || formatDate(primary.created_at)}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  function renderSentencePanel() {
    if (!selectedSentence) {
      return <div className="empty centered">从左侧选择一句，查看剧照、编辑文本并分析词性。</div>;
    }
    return (
      <section className="sentence-panel">
        <div className="sentence-shot">
          {selectedSentence.screenshot_path ? (
            <img src={screenshotUrl(selectedSentence.id)} alt={`${selectedSentence.surface} screenshot`} />
          ) : (
            <div className="empty centered">这句还没有剧照。</div>
          )}
        </div>
        <div className="sentence-workbench">
          <div className="sentence-analysis">
            <div className="sentence-analysis-header">
              <div className="section-title">
                <MessageSquareText size={17} />
                <span>词性标注</span>
              </div>
              <div className="sentence-actions">
                <button className="icon-button" onClick={() => setEditingSentence(true)} title="编辑句子">
                  <Pencil size={15} />
                </button>
                <button className="runtime-action compact" onClick={() => analyzeSentence()} disabled={sentenceBusy}>
                  <Sparkles size={15} />
                  <span>分析词性</span>
                </button>
              </div>
            </div>
            <div className="sentence-token-row">
              {sentenceTokens.length ? sentenceTokens.map((token, idx) => (
                <span
                  role="button"
                  tabIndex={0}
                  key={`${token.surface}-${idx}`}
                  className={`sentence-token ${posClass(token.pos)} ${isKnownToken(token) ? "known" : ""}`}
                  onClick={() => onLookupToken(token)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onLookupToken(token);
                  }}
                  title="点击查词典"
                >
                  {hasKanji(token.surface) && token.reading ? (
                    <ruby>
                      <strong>{token.surface}</strong>
                      <rt>{toHiragana(token.reading)}</rt>
                    </ruby>
                  ) : (
                    <strong>{token.surface}</strong>
                  )}
                  <em>{[token.pos, token.jlpt_level].filter(Boolean).join(" · ")}</em>
                </span>
              )) : <div className="empty">点击“分析词性”生成标注。</div>}
            </div>
            {sentenceZh ? <div className="sentence-text-preview">{sentenceZh}</div> : null}
            {selectedTokenLookup ? (
              <div className="token-dict-card">
                <strong>{selectedTokenLookup.lemma}</strong>
                {selectedTokenLookup.reading ? <span>{selectedTokenLookup.reading}</span> : null}
                {selectedTokenLookup.meanings.length ? (
                  <ol>
                    {selectedTokenLookup.meanings.map((meaning) => <li key={meaning}>{meaning}</li>)}
                  </ol>
                ) : <p>未查到释义。</p>}
              </div>
            ) : null}
          </div>
        </div>
        {editingSentence ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="sentence-edit-modal">
              <div className="modal-header">
                <div className="section-title">
                  <Pencil size={17} />
                  <span>编辑句子</span>
                </div>
                <button className="icon-button" onClick={() => setEditingSentence(false)} title="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className="sentence-editor">
                <label>
                  <span>日语句子</span>
                  <textarea value={sentenceJa} onChange={(event) => setSentenceJa(event.target.value)} />
                </label>
                <label>
                  <span>中文句子</span>
                  <textarea value={sentenceZh} onChange={(event) => setSentenceZh(event.target.value)} />
                </label>
                <div className="sentence-actions">
                  <button className="runtime-action compact" onClick={onSaveSentenceText} disabled={sentenceBusy}>
                    <Save size={15} />
                    <span>保存文本</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  function renderSourceList() {
    if (!playerNodes.length) {
      return <div className="empty">暂无来源。先在 B 站扩展里保存一个词条。</div>;
    }

    return (
      <div className="source-list">
        {playerNodes.map((node, idx) => {
          const key = sourceKey(node);
          const collapsed = collapsedSources.has(key);
          const groupedByHead = new Map<number, VocabItem[]>();
          node.items.forEach((item) => {
            const arr = groupedByHead.get(item.head_id) || [];
            arr.push(item);
            groupedByHead.set(item.head_id, arr);
          });

          return (
            <section className="source-block" key={`${key}-${idx}`}>
              <button
                className={`source-heading source-heading-button ${
                  selectedSource && sourceKey(selectedSource) === key
                    ? "active"
                    : ""
                }`}
                onClick={() => onSelectSource(node)}
                title="查看本剧统计"
              >
                <Clapperboard size={16} />
                <div>
                  <strong>{node.series_name}</strong>
                  <span>{sourceLabel(node.source)} · {node.episode_name}</span>
                </div>
              </button>
              <div className="source-tools">
                <button className="source-tool-button" onClick={() => toggleSourceCollapsed(node)} title={collapsed ? "展开" : "折叠"}>
                  <ChevronDown size={14} className={collapsed ? "collapsed" : ""} />
                  <span>{collapsed ? "展开" : "折叠"}</span>
                </button>
                <button className="source-tool-button danger" onClick={() => onDeleteSourceGroup(node)} title="删除整集内容">
                  <Trash2 size={14} />
                  <span>删除整集</span>
                </button>
              </div>
              {!collapsed ? <div className="word-grid">
                {Array.from(groupedByHead.entries()).map(([headId, items]) => (
                  <button
                    key={headId}
                    className={`word-chip ${selectedHeadId === headId ? "active" : ""}`}
                    onClick={() => onSelectHead(headId)}
                    title={`查看 ${items.length} 条实例`}
                  >
                    <span>{items[0].surface}</span>
                    <small>{items.length}</small>
                  </button>
                ))}
              </div> : null}
            </section>
          );
        })}
      </div>
    );
  }

  function renderTimeList() {
    if (!timeItems.length) {
      return <div className="empty">暂无时间线数据。保存词条后会自动出现。</div>;
    }

    return (
      <div className="timeline">
        {filteredTimeItems.map((item) => (
          <button
            key={detailKey(item)}
            className={`timeline-item ${selectedHeadId === item.head_id ? "active" : ""}`}
            onClick={() => onSelectHead(item.head_id)}
          >
            <span className="timeline-word">{item.surface}</span>
            <span className="timeline-meta">{formatDate(item.created_at)}</span>
          </button>
        ))}
      </div>
    );
  }

  function renderRuntimePanel() {
    const loadState = asrStatus?.load_state?.state || "idle";
    const loadLabel =
      loadState === "loading" ? "下载/加载中" : asrStatus?.loaded ? "已加载" : loadState === "error" ? "失败" : "未加载";
    const progress = asrStatus?.download_progress;
    const progressPercent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));

    return (
      <section className="runtime-pane">
        <div className="runtime-grid">
          <section className="runtime-card">
            <div className="section-title">
              <Server size={17} />
              <span>Sidecar</span>
            </div>
            <div className="runtime-kv">
              <span>状态</span>
              <strong>{sidecarStatus?.state || "unknown"}</strong>
              <span>进程</span>
              <strong>{sidecarStatus?.pid ? `PID ${sidecarStatus.pid}` : sidecarStatus?.managed ? "托管中" : "外部进程"}</strong>
              <span>地址</span>
              <strong>{SIDECAR_BASE}</strong>
              <span>信息</span>
              <strong>{sidecarStatus?.message || "-"}</strong>
            </div>
            <button className="runtime-action" onClick={onRestartSidecar}>
              <RefreshCw size={16} />
              <span>重启 Sidecar</span>
            </button>
          </section>

          <section className="runtime-card">
            <div className="section-title">
              <Cpu size={17} />
              <span>ASR 模型</span>
            </div>
            <div className="model-status">
              <div className={`model-badge ${asrStatus?.loaded ? "ready" : loadState}`}>
                {loadLabel}
              </div>
              <h2>{asrStatus?.model_size || "small"}</h2>
              <p>
                compute: {asrStatus?.compute_type || "-"} · local only: {String(asrStatus?.local_files_only || false)}
              </p>
            </div>
            {progress ? (
              <div className="model-progress">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
                <div className="progress-meta">
                  <span>{progressPercent}%</span>
                  <span>
                    {formatBytes(progress.downloaded_bytes)} / {progress.total_bytes ? formatBytes(progress.total_bytes) : "未知大小"}
                  </span>
                </div>
              </div>
            ) : null}
            {asrStatus?.load_state?.error ? <div className="runtime-error">{asrStatus.load_state.error}</div> : null}
            <button className="runtime-action" onClick={onStartModelLoad} disabled={loadState === "loading"}>
              <Download size={16} />
              <span>{loadState === "loading" ? "正在处理" : "下载/加载模型"}</span>
            </button>
          </section>
        </div>

        <section className="log-panel">
          <div className="log-header">
            <div className="section-title">
              <Terminal size={17} />
              <span>日志</span>
            </div>
            <button className="link-button" onClick={onClearLogs}>清空</button>
          </div>
          <div className="log-list">
            {logs.length ? (
              logs.map((entry) => (
                <div className={`log-line ${entry.level}`} key={entry.id}>
                  <span>{new Date(entry.at).toLocaleTimeString()}</span>
                  <strong>{entry.source}</strong>
                  <code>{entry.message}</code>
                </div>
              ))
            ) : (
              <div className="empty centered">暂无日志。</div>
            )}
          </div>
        </section>
      </section>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={22} />
          </div>
          <div>
            <h1>Drama Wordbook</h1>
            <p>看剧生词、例句和剧照工作台</p>
          </div>
        </div>
        <div className="top-actions">
          <div className={`service-pill ${isSidecarOnline ? "online" : "offline"}`}>
            <Server size={16} />
            <span>{serviceText}</span>
          </div>
          <button
            className="icon-button"
            onClick={() => {
              if (isSidecarOnline) {
                loadAll(true);
              } else {
                onRestartSidecar();
              }
            }}
            disabled={loading}
            title={isSidecarOnline ? "刷新" : "重启 sidecar"}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="nav-rail">
          <button className={view === "byPlayer" ? "active" : ""} onClick={() => setView("byPlayer")} title="按来源">
            <Clapperboard size={19} />
          </button>
          <button className={view === "byTime" ? "active" : ""} onClick={() => setView("byTime")} title="按时间">
            <CalendarClock size={19} />
          </button>
          <button className={view === "sentences" ? "active" : ""} onClick={() => setView("sentences")} title="句子">
            <MessageSquareText size={19} />
          </button>
          <button className={view === "runtime" ? "active" : ""} onClick={() => setView("runtime")} title="运行中心">
            <Terminal size={19} />
          </button>
        </aside>

        {view !== "runtime" ? <section className="library-pane">
          <div className="pane-header">
            <div>
              <span className="eyebrow">{view === "byPlayer" ? "来源浏览" : view === "sentences" ? "句子浏览" : "时间线"}</span>
              <h2>{view === "byPlayer" ? "按剧集整理" : view === "sentences" ? "句子项目" : "按保存时间"}</h2>
            </div>
          </div>

          <label className="search-box">
            <Search size={16} />
            <input
              placeholder="搜索词面、读音、释义或例句"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          {error ? (
            <div className="connection-card">
              <strong>{sidecarStatus?.state === "starting" ? "本地服务正在启动" : "连接不到本地服务"}</strong>
              <span>
                {sidecarStatus?.message || `桌面端会自动启动并守护 ${SIDECAR_BASE}，也可以点击右上角重试。`}
              </span>
            </div>
          ) : null}

          <div className="scroll-area">{view === "byPlayer" ? renderSourceList() : view === "sentences" ? renderSentenceList() : renderTimeList()}</div>
        </section> : null}

        <section className={view === "runtime" ? "detail-pane detail-pane-wide" : "detail-pane"}>
          {view === "runtime" ? renderRuntimePanel() : null}
          {view === "sentences" ? renderSentencePanel() : null}
          {view !== "runtime" ? (
          <>
          {view !== "sentences" ? (
          <>
          {selectedSource ? (
            <section className="source-stats-panel">
              <div className="stats-row">
                <div className="stat">
                  <span>{sourceStats.words}</span>
                  <small>词头</small>
                </div>
                <div className="stat">
                  <span>{sourceStats.examples}</span>
                  <small>例句</small>
                </div>
                <div className="stat">
                  <span>{sourceStats.screenshots}</span>
                  <small>剧照</small>
                </div>
                <div className="stat">
                  <span>{formatTime(sourceStats.latestTime)}</span>
                  <small>最晚进度</small>
                </div>
              </div>
              <div className="carousel">
                {carouselItem ? (
                  <>
                    <img src={screenshotUrl(carouselItem.id)} alt={`${carouselItem.surface} screenshot`} />
                    <div className="carousel-caption">
                      <div>
                        <strong>{carouselItem.example_ja || carouselItem.surface}</strong>
                        {carouselItem.example_zh ? <span>{carouselItem.example_zh}</span> : null}
                      </div>
                      <small>
                        {carouselItem.surface} · {formatTime(carouselItem.playback?.current_time || 0)}
                      </small>
                    </div>
                  </>
                ) : (
                  <div className="empty centered">这个来源还没有剧照。</div>
                )}
              </div>
            </section>
          ) : null}

          {!selectedSource ? <div className="detail-grid">
            <section className="definition-panel">
              <div className="section-title">
                <Sparkles size={17} />
                <span>词典</span>
              </div>
              {!selectedItems.length ? (
                <div className="empty centered">从左侧选择一个词条查看详情。</div>
              ) : (
                <>
                  <div className="word-title">
                    <h2>{selectedTitle}</h2>
                    {selectedItems[0]?.reading ? <span>{selectedItems[0].reading}</span> : null}
                    {selectedItems[0]?.jlpt_level ? <span className="jlpt-pill">{selectedItems[0].jlpt_level}</span> : null}
                  </div>
                  {selectedMeanings.length ? (
                    <ol className="meaning-list">
                      {selectedMeanings.map((meaning) => (
                        <li key={meaning}>{meaning}</li>
                      ))}
                    </ol>
                  ) : (
                    <div className="empty">暂无释义。</div>
                  )}
                </>
              )}
            </section>
          </div> : null}

          {!selectedSource ? <section className="examples-panel">
            <div className="section-title">
              <BookOpen size={17} />
              <span>例句实例</span>
            </div>
            <div className="example-list">
              {loading ? <div className="empty">加载中...</div> : null}
              {!loading && !selectedItems.length && !selectedSource ? <div className="empty">选择词条后会显示所有保存过的语境。</div> : null}
              {selectedItems.map((item) => (
                <article className="example-card" key={detailKey(item)}>
                  {item.screenshot_path ? (
                    <button className="example-shot" onClick={() => openExternal(screenshotUrl(item.id))}>
                      <img src={screenshotUrl(item.id)} alt={`${item.surface} screenshot`} />
                    </button>
                  ) : null}
                  <div className="example-main">
                    <strong>
                      {item.jlpt_level ? <span className="jlpt-pill inline">{item.jlpt_level}</span> : null}
                      {item.example_ja || item.surface}
                    </strong>
                    {item.example_zh ? <span>{item.example_zh}</span> : null}
                  </div>
                  <div className="example-meta">
                    <span>{formatDate(item.created_at)}</span>
                    {item.playback?.title ? <span>{item.playback.title}</span> : null}
                    {item.playback?.url ? (
                      <button
                        className="link-button"
                        onClick={() => openExternal(item.playback?.url || "")}
                        title="在浏览器打开来源"
                      >
                        <ExternalLink size={14} />
                        <span>{formatTime(item.playback.current_time)}</span>
                      </button>
                    ) : null}
                    <button className="danger-button" onClick={() => onDeleteExample(item)} title="删除例句">
                      <Trash2 size={14} />
                      <span>删除</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section> : null}
          </>
          ) : null}
          </>
          ) : null}
        </section>
      </main>
    </div>
  );
}

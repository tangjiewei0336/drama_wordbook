import { useEffect, useMemo, useState } from "react";
import { fetchByPlayer, fetchByTime, fetchHeadItems, type PlayerNode, type VocabItem } from "./api";
import "./styles.css";

type ViewMode = "byPlayer" | "byTime";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function detailKey(item: VocabItem): string {
  return `${item.id}-${item.head_id}`;
}

export default function App() {
  const [view, setView] = useState<ViewMode>("byPlayer");
  const [playerNodes, setPlayerNodes] = useState<PlayerNode[]>([]);
  const [timeItems, setTimeItems] = useState<VocabItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<VocabItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [nodes, timeList] = await Promise.all([fetchByPlayer(), fetchByTime()]);
      setPlayerNodes(nodes);
      setTimeItems(timeList);
      if (view === "byTime") {
        setSelectedItems(timeList.slice(0, 20));
      }
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const filteredTimeItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return timeItems;
    return timeItems.filter((item) =>
      [item.surface, item.reading, item.meanings.join(" "), item.example_ja]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [timeItems, search]);

  async function onSelectHead(headId: number) {
    setLoading(true);
    try {
      const items = await fetchHeadItems(headId);
      setSelectedItems(items);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  function renderPlayerTree() {
    return (
      <div className="tree">
        {playerNodes.map((node, idx) => {
          const groupedByHead = new Map<number, VocabItem[]>();
          node.items.forEach((item) => {
            const arr = groupedByHead.get(item.head_id) || [];
            arr.push(item);
            groupedByHead.set(item.head_id, arr);
          });
          return (
            <div className="tree-node" key={`${node.platform}-${node.series_name}-${node.episode_name}-${idx}`}>
              <div className="tree-label">
                {node.platform} / {node.series_name} / {node.episode_name}
              </div>
              <div className="tree-actions">
                {Array.from(groupedByHead.entries()).map(([headId, items]) => (
                  <button
                    key={headId}
                    className="chip"
                    onClick={() => onSelectHead(headId)}
                    title={`查看 ${items.length} 条实例`}
                  >
                    {items[0].surface} ({items.length})
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderTimeList() {
    return (
      <div className="tree">
        <input
          className="search"
          placeholder="搜索词面 / 释义 / 例句"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {filteredTimeItems.map((item) => (
          <button key={detailKey(item)} className="time-item" onClick={() => onSelectHead(item.head_id)}>
            <span>{item.surface}</span>
            <span className="muted">{formatDate(item.created_at)}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Vocab Explorer</h1>
        <div className="header-actions">
          <button className={view === "byPlayer" ? "active" : ""} onClick={() => setView("byPlayer")}>
            按播放器组织
          </button>
          <button className={view === "byTime" ? "active" : ""} onClick={() => setView("byTime")}>
            按时间
          </button>
          <button onClick={loadAll}>刷新</button>
        </div>
      </header>
      {error ? <div className="error">{error}</div> : null}
      <div className="layout">
        <aside className="sidebar">{view === "byPlayer" ? renderPlayerTree() : renderTimeList()}</aside>
        <main className="detail">
          {loading ? <div className="muted">加载中...</div> : null}
          {!loading && selectedItems.length === 0 ? <div className="muted">选择左侧节点查看词条实例</div> : null}
          {selectedItems.map((item) => (
            <article className="card" key={detailKey(item)}>
              <div className="row">
                <strong>{item.surface}</strong>
                <span className="muted">{item.reading}</span>
              </div>
              <div className="muted">{item.meanings.join("；")}</div>
              <div className="example">{item.example_ja}</div>
              {item.example_zh ? <div className="example zh">{item.example_zh}</div> : null}
              <div className="meta">
                <span>{formatDate(item.created_at)}</span>
                {item.playback?.title ? <span>{item.playback.title}</span> : null}
                {item.playback?.current_time ? (
                  <a href={item.playback.url} target="_blank" rel="noreferrer">
                    跳转 {item.playback.current_time.toFixed(1)}s
                  </a>
                ) : null}
              </div>
              {item.screenshot_path ? <div className="muted">截图: {item.screenshot_path}</div> : null}
            </article>
          ))}
        </main>
      </div>
    </div>
  );
}

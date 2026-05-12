import {
  BookOpen,
  CalendarClock,
  ChevronDown,
  Clapperboard,
  Cloud,
  Cpu,
  Download,
  ExternalLink,
  LogIn,
  MessageCircle,
  Palette,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sparkles,
  Save,
  MessageSquareText,
  Pencil,
  Send,
  User,
  Users,
  Volume2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAsrStatus,
  deletePlayerGroup,
  deleteVocabItem,
  deleteSentence,
  fetchByPlayer,
  fetchByTime,
  createPartnerRequest,
  collectShareSentence,
  fetchDesktopSettings,
  fetchDramaSpace,
  fetchSyncConflicts,
  fetchHeadItems,
  fetchHealth,
  fetchProfile,
  fetchSentences,
  fetchSyncConfig,
  acceptPartnerRequest,
  loginSync,
  logoutSync,
  replyShare,
  pullSync,
  resolveSyncConflict,
  registerSync,
  lookupDictionary,
  runSync,
  saveProfile,
  sentenceScreenshotUrl,
  shareSentence,
  shareScreenshotUrl,
  screenshotUrl,
  DEFAULT_PUBLIC_SYNC_SERVER,
  SIDECAR_BASE,
  startAsrModelLoad,
  tokenizeJapanese,
  updateSentence,
  updateDesktopSettings,
  updateSyncConfig,
  type AsrModelStatus,
  type DictLookupResult,
  type DesktopSettings,
  type HealthStatus,
  type JaToken,
  type PlayerNode,
  type Profile,
  type DramaSpace,
  type SentenceRecord,
  type SidecarProcessStatus,
  type SyncConfig,
  type SyncConflict,
  type VocabItem,
} from "./api";
import "./styles.css";
import avatar01Thumb from "./assets/avatars/100/avatar-01.jpg";
import avatar02Thumb from "./assets/avatars/100/avatar-02.jpg";
import avatar03Thumb from "./assets/avatars/100/avatar-03.jpg";
import avatar04Thumb from "./assets/avatars/100/avatar-04.jpg";
import avatar05Thumb from "./assets/avatars/100/avatar-05.jpg";
import avatar06Thumb from "./assets/avatars/100/avatar-06.jpg";
import avatar01Full from "./assets/avatars/500/avatar-01.jpg";
import avatar02Full from "./assets/avatars/500/avatar-02.jpg";
import avatar03Full from "./assets/avatars/500/avatar-03.jpg";
import avatar04Full from "./assets/avatars/500/avatar-04.jpg";
import avatar05Full from "./assets/avatars/500/avatar-05.jpg";
import avatar06Full from "./assets/avatars/500/avatar-06.jpg";

type ViewMode = "byPlayer" | "byTime";
type MainMode = ViewMode | "sentences" | "space" | "profile" | "runtime";
type SelectedSource = Pick<PlayerNode, "platform" | "source" | "series_name" | "episode_name" | "items"> | null;
type LogEntry = { id: string; at: string; level: string; source: string; message: string };
type SentenceGroup = {
  key: string;
  text: string;
  zh: string;
  items: SentenceRecord[];
};
type PresetAvatar = {
  id: string;
  originalName: string;
  thumbUrl: string;
  fullUrl: string;
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

function withPlaybackTime(url: string, currentTime = 0): string {
  const clean = String(url || "").trim();
  if (!clean) return "";
  try {
    const parsed = new URL(clean);
    const sec = Math.max(0, Math.floor(Number(currentTime || 0)));
    if (sec > 0) parsed.searchParams.set("t", String(sec));
    return parsed.toString();
  } catch {
    return clean;
  }
}

function normalizeSyncAuthError(raw: unknown): string {
  const text = String((raw as Error)?.message || raw || "").trim();
  if (!text) return "登录失败，请稍后重试。";
  if (text.includes("invalid username or password")) return "账号不存在或密码错误。";
  if (text.includes("username already exists")) return "该用户名已注册，请直接登录。";
  if (text.includes("invite code is required")) return "注册需要邀请码。";
  if (text.includes("invite code is invalid or already used")) return "邀请码无效或已被使用。";
  return text;
}

function normalizeSpaceError(raw: unknown): string {
  const text = String((raw as Error)?.message || raw || "").trim();
  if (!text) return "操作未完成，请稍后重试。";
  if (text.includes("partner not found")) return "找不到搭子账号，请确认用户名。";
  if (text.includes("you already have a partner")) return "你已经有搭子了，不能再发送申请。";
  if (text.includes("target already has a partner")) return "对方已经有搭子了。";
  return text;
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

const CIRCLED_NUMBERS = ["⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
const THEME_COLORS = ["#2e8f76", "#d65f4a", "#4f7cff", "#a85539", "#7c3aed", "#0f766e"];
const START_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
const END_HOUR_OPTIONS = [...START_HOUR_OPTIONS, "24:00"];
const PRESET_AVATARS: PresetAvatar[] = [
  { id: "avatar-01", originalName: "你不要过来啊", thumbUrl: avatar01Thumb, fullUrl: avatar01Full },
  { id: "avatar-02", originalName: "高兴的小男孩", thumbUrl: avatar02Thumb, fullUrl: avatar02Full },
  { id: "avatar-03", originalName: "可爱的小女孩", thumbUrl: avatar03Thumb, fullUrl: avatar03Full },
  { id: "avatar-04", originalName: "メロメロ", thumbUrl: avatar04Thumb, fullUrl: avatar04Full },
  { id: "avatar-05", originalName: "我们天下第一最最好", thumbUrl: avatar05Thumb, fullUrl: avatar05Full },
  { id: "avatar-06", originalName: "我要过来啦", thumbUrl: avatar06Thumb, fullUrl: avatar06Full },
];

function accentMark(accent?: number | null): string {
  if (accent === null || accent === undefined) return "";
  return CIRCLED_NUMBERS[accent] || `(${accent})`;
}

function speakJapanese(text = "") {
  const value = text.trim();
  if (!value || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = "ja-JP";
  utterance.rate = 0.92;
  window.speechSynthesis.speak(utterance);
}

async function imageUrlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Avatar fetch failed: ${res.status}`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Avatar convert failed"));
    reader.readAsDataURL(blob);
  });
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
  const autoSyncRunningRef = useRef(false);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarProcessStatus | null>(null);
  const [asrStatus, setAsrStatus] = useState<AsrModelStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [playerNodes, setPlayerNodes] = useState<PlayerNode[]>([]);
  const [timeItems, setTimeItems] = useState<VocabItem[]>([]);
  const [sentences, setSentences] = useState<SentenceRecord[]>([]);
  const [sentenceTotal, setSentenceTotal] = useState(0);
  const [space, setSpace] = useState<DramaSpace | null>(null);
  const [profile, setProfile] = useState<Profile>({
    nickname: "Drama Learner",
    avatar_data_url: "",
    theme_color: "#2e8f76",
    signature: "",
  });
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings>({
    notification_window_start: "18:00",
    notification_window_end: "24:00",
  });
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [desktopSettingBusy, setDesktopSettingBusy] = useState(false);
  const [desktopSettingsError, setDesktopSettingsError] = useState("");
  const [syncConfig, setSyncConfig] = useState<SyncConfig>({ server_url: "", access_token: "", username: "", last_sync_at: "", last_server_version: 0, auto_sync_interval_minutes: 0 });
  const [loginForm, setLoginForm] = useState({
    serverUrl: DEFAULT_PUBLIC_SYNC_SERVER,
    username: "",
    password: "",
    inviteCode: "",
  });
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
  const [definitionOnlineLookup, setDefinitionOnlineLookup] = useState<DictLookupResult | null>(null);
  const [definitionLookupBusy, setDefinitionLookupBusy] = useState(false);
  const [sentenceBusy, setSentenceBusy] = useState(false);
  const [editingSentence, setEditingSentence] = useState(false);
  const [sharingSentence, setSharingSentence] = useState(false);
  const [shareComment, setShareComment] = useState("");
  const [replyDraftByShare, setReplyDraftByShare] = useState<Record<number, string>>({});
  /** 追剧空间 · 搭子分享详情（弹窗） */
  const [shareDetailModalId, setShareDetailModalId] = useState<number | null>(null);
  const [syncError, setSyncError] = useState("");
  const [spaceError, setSpaceError] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [profileError, setProfileError] = useState("");
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [avatarSelectingId, setAvatarSelectingId] = useState("");
  const [selectedPresetAvatarId, setSelectedPresetAvatarId] = useState("");
  const [partnerRequestName, setPartnerRequestName] = useState("");
  const [partnerBusy, setPartnerBusy] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [resolvingConflictKey, setResolvingConflictKey] = useState("");
  const [loading, setLoading] = useState(false);
  const isSidecarOnline = Boolean(sidecarStatus?.healthy || health);
  const appStyle = { "--theme-color": profile.theme_color, "--partner-color": "#d65f4a" } as CSSProperties;
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
  const isProfileLocked = !syncConfig.access_token;

  async function loadAll(keepSelection = true) {
    setLoading(true);
    setLibraryError("");
    try {
      const [healthRes, nodes, timeList, sentenceList, profileRes, syncRes, spaceRes, desktopSettingRes] = await Promise.all([
        fetchHealth(),
        fetchByPlayer(),
        fetchByTime(),
        fetchSentences(),
        fetchProfile(),
        fetchSyncConfig(),
        fetchDramaSpace(),
        fetchDesktopSettings(),
      ]);
      setHealth(healthRes);
      if (healthRes.asr) setAsrStatus(healthRes.asr);
      setPlayerNodes(nodes);
      setTimeItems(timeList);
      setSentences(sentenceList.items || []);
      setSentenceTotal(sentenceList.total || 0);
      setProfile(profileRes);
      setSyncConfig(syncRes);
      setLoginForm((current) => ({ ...current, serverUrl: syncRes.server_url || current.serverUrl, username: syncRes.username || current.username }));
      setSpace(spaceRes);
      setDesktopSettings(desktopSettingRes);

      if (keepSelection && selectedHeadId) {
        setSelectedItems(await fetchHeadItems(selectedHeadId));
      } else if (!keepSelection) {
        setSelectedItems([]);
        setSelectedHeadId(null);
        setSelectedSource(null);
      }
    } catch (err) {
      setHealth(null);
      setLibraryError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll(false);
  }, []);

  useEffect(() => {
    window.wordbookDesktop?.getLaunchAtLogin?.().then((enabled) => {
      setLaunchAtLogin(Boolean(enabled));
    });
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
    if (view !== "profile") return;
    refreshSyncConflicts();
  }, [view, syncConfig.access_token]);

  useEffect(() => {
    const intervalMinutes = Number(syncConfig.auto_sync_interval_minutes || 0);
    if (!syncConfig.access_token || intervalMinutes <= 0) return;
    const timer = window.setInterval(async () => {
      if (autoSyncRunningRef.current) return;
      autoSyncRunningRef.current = true;
      try {
        const result = await runSync();
        if (result.state === "needs_pull") {
          const conflictsRes = await fetchSyncConflicts().catch(() => ({ items: [] as SyncConflict[] }));
          setSyncConflicts(conflictsRes.items || []);
          setProfileError(result.message || "云端有新变化，请先下载云端更新");
          return;
        }
        setSyncConfig(await fetchSyncConfig());
        setSyncConflicts([]);
        setSpace(await fetchDramaSpace());
      } catch (err) {
        setProfileError(`自动同步失败：${String((err as Error).message || err)}`);
      } finally {
        autoSyncRunningRef.current = false;
      }
    }, intervalMinutes * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [syncConfig.access_token, syncConfig.auto_sync_interval_minutes]);

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

  const definitionLookupKey = useMemo(() => {
    if (!selectedHeadId || !selectedItems.length) return "";
    const head = selectedItems[0];
    const lemma = String(head?.dictionary_form || head?.surface || "").trim();
    return lemma ? `${selectedHeadId}::${lemma}` : `${selectedHeadId}::`;
  }, [selectedHeadId, selectedItems]);

  useEffect(() => {
    if (!definitionLookupKey || !definitionLookupKey.includes("::")) {
      setDefinitionOnlineLookup(null);
      setDefinitionLookupBusy(false);
      return;
    }
    const [, lemma] = definitionLookupKey.split("::");
    const clean = lemma.trim();
    if (!clean) {
      setDefinitionOnlineLookup(null);
      return;
    }
    let cancelled = false;
    setDefinitionLookupBusy(true);
    lookupDictionary(clean)
      .then((res) => {
        if (!cancelled) setDefinitionOnlineLookup(res);
      })
      .catch(() => {
        if (!cancelled) setDefinitionOnlineLookup(null);
      })
      .finally(() => {
        if (!cancelled) setDefinitionLookupBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionLookupKey]);

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
    () => sentences.find((item) => item.id === selectedSentenceId) || null,
    [sentences, selectedSentenceId]
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
    const q = search.trim().toLowerCase();
    sentences
      .filter((item) =>
        !q
          ? true
          : [item.example_ja, item.example_zh, item.tags.join(" "), item.playback?.title]
              .join(" ")
              .toLowerCase()
              .includes(q)
      )
      .forEach((item) => {
      const text = item.example_ja.trim();
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
  }, [sentences, search]);

  async function onSelectHead(headId: number) {
    setLoading(true);
    setLibraryError("");
    try {
      setSelectedHeadId(headId);
      setSelectedSource(null);
      setSelectedItems(await fetchHeadItems(headId));
    } catch (err) {
      setLibraryError(String((err as Error).message || err));
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
    setLibraryError("");
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
      setLibraryError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteExample(item: VocabItem) {
    if (!window.confirm(`删除这条例句？\n${item.example_ja || item.surface}`)) return;
    setLoading(true);
    setLibraryError("");
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
      setLibraryError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onRestartSidecar() {
    setLibraryError("");
    await window.wordbookDesktop?.restartSidecar?.();
    setTimeout(() => loadAll(true), 1200);
  }

  async function onStartModelLoad() {
    setLibraryError("");
    try {
      setAsrStatus(await startAsrModelLoad());
      setView("runtime");
    } catch (err) {
      setLibraryError(String((err as Error).message || err));
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
    setLibraryError("");
    try {
      setSentenceTokens(await tokenizeJapanese(clean));
      setSelectedTokenLookup(null);
    } catch (err) {
      setLibraryError(String((err as Error).message || err));
    } finally {
      setSentenceBusy(false);
    }
  }

  async function onSelectSentence(item: SentenceRecord, groupKey = "") {
    setSelectedSentenceId(item.id);
    setSelectedSentenceKey(groupKey);
    setSentenceJa(item.example_ja || "");
    setSentenceZh(item.example_zh || "");
    setEditingSentence(false);
    setSelectedHeadId(null);
    setSelectedSource(null);
    await analyzeSentence(item.example_ja || "");
  }

  async function onSaveSentenceText() {
    if (!selectedSentence) return;
    setSentenceBusy(true);
    setLibraryError("");
    try {
      const updated = await updateSentence(selectedSentence.id, sentenceJa, sentenceZh, selectedSentence.tags || []);
      setSentences((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setPlayerNodes(await fetchByPlayer());
      if (selectedSentenceKey) {
        const group = sentenceGroups.find((entry) => entry.key === selectedSentenceKey);
        if (group) {
          await Promise.all(
            group.items
              .filter((item) => item.id !== selectedSentence.id)
              .map((item) => updateSentence(item.id, sentenceJa, sentenceZh, item.tags || []).catch(() => null))
          );
          const [nodes, timeList, sentenceList] = await Promise.all([fetchByPlayer(), fetchByTime(), fetchSentences()]);
          setPlayerNodes(nodes);
          setTimeItems(timeList);
          setSentences(sentenceList.items || []);
        }
      }
      setEditingSentence(false);
      await analyzeSentence(sentenceJa);
    } catch (err) {
      setLibraryError(String((err as Error).message || err));
    } finally {
      setSentenceBusy(false);
    }
  }

  async function onDeleteSentence() {
    if (!selectedSentence) return;
    const wordCount = Number(selectedSentence.word_count || 0);
    const suffix = wordCount ? `\n\n同时会删除和这句绑定的 ${wordCount} 个单词。` : "";
    if (!window.confirm(`删除这句？\n${selectedSentence.example_ja || sentenceJa}${suffix}`)) return;
    setSentenceBusy(true);
    setLibraryError("");
    try {
      await deleteSentence(selectedSentence.id);
      setSelectedSentenceId(null);
      setSelectedSentenceKey("");
      setSentenceJa("");
      setSentenceZh("");
      setSentenceTokens([]);
      setSelectedTokenLookup(null);
      const [nodes, timeList, sentenceList, spaceRes] = await Promise.all([fetchByPlayer(), fetchByTime(), fetchSentences(), fetchDramaSpace()]);
      setPlayerNodes(nodes);
      setTimeItems(timeList);
      setSentences(sentenceList.items || []);
      setSentenceTotal(sentenceList.total || 0);
      setSpace(spaceRes);
    } catch (err) {
      setLibraryError(String((err as Error).message || err));
    } finally {
      setSentenceBusy(false);
    }
  }

  async function onLookupToken(token: JaToken) {
    const lemma = token.dictionary_form || token.surface;
    if (!lemma) return;
    setSentenceBusy(true);
    setLibraryError("");
    try {
      const result = await lookupDictionary(lemma);
      setSelectedTokenLookup(result);
      if (!result.meanings?.length) {
        setLibraryError(`未查到「${lemma}」的释义。可能是词形未收录，或当前网络无法访问外部词典。`);
      }
    } catch (err) {
      setLibraryError(String((err as Error).message || err));
    } finally {
      setSentenceBusy(false);
    }
  }

  async function onShareSentence() {
    if (!selectedSentence) return;
    const partner = (space?.partner?.username || "").trim();
    if (!partner) return;
    setSentenceBusy(true);
    setSpaceError("");
    try {
      await shareSentence(selectedSentence.id, partner, shareComment);
      setShareComment("");
      setSharingSentence(false);
    } catch (err) {
      setSpaceError(normalizeSpaceError(err));
    } finally {
      setSentenceBusy(false);
    }
  }

  async function onCollectShare(share: NonNullable<DramaSpace["unread_shares"]>[number]) {
    setPartnerBusy(true);
    setSpaceError("");
    try {
      await collectShareSentence(share);
      await loadAll(true);
    } catch (err) {
      setSpaceError(normalizeSpaceError(err));
    } finally {
      setPartnerBusy(false);
    }
  }

  async function onReplyShare(shareId: number) {
    const text = (replyDraftByShare[shareId] || "").trim();
    if (!text) return;
    setPartnerBusy(true);
    setSpaceError("");
    try {
      await replyShare(shareId, text);
      setReplyDraftByShare((current) => ({ ...current, [shareId]: "" }));
      await loadAll(true);
    } catch (err) {
      setSpaceError(normalizeSpaceError(err));
    } finally {
      setPartnerBusy(false);
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
            <img src={sentenceScreenshotUrl(selectedSentence.id)} alt="sentence screenshot" />
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
                <button className="icon-button" onClick={() => speakJapanese(sentenceJa)} title="朗读句子">
                  <Volume2 size={15} />
                </button>
                <button className="icon-button" onClick={() => setEditingSentence(true)} title="编辑句子">
                  <Pencil size={15} />
                </button>
                <button className="icon-button" onClick={onDeleteSentence} disabled={sentenceBusy} title="删除句子">
                  <Trash2 size={15} />
                </button>
                {space?.partner?.username ? (
                  <button className="icon-button" onClick={() => setSharingSentence(true)} title="分享给搭子">
                    <Send size={15} />
                  </button>
                ) : null}
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
                  <em>{[token.reading && !hasKanji(token.surface) ? toHiragana(token.reading) : "", accentMark(token.accent), token.pos, token.jlpt_level].filter(Boolean).join(" · ")}</em>
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
        {sharingSentence ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="sentence-edit-modal">
              <div className="modal-header">
                <div className="section-title">
                  <Send size={17} />
                  <span>分享给搭子</span>
                </div>
                <button className="icon-button" onClick={() => setSharingSentence(false)} title="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className="sentence-editor">
                <div className="share-preview">
                  <strong>{sentenceJa}</strong>
                  {sentenceZh ? <span>{sentenceZh}</span> : null}
                </div>
                <div className="share-comment-row">
                  <label className="share-comment-editor">
                    <span>评论</span>
                    <input
                      value={shareComment}
                      placeholder="写一句想对搭子说的话"
                      onChange={(event) => setShareComment(event.target.value)}
                    />
                  </label>
                  <aside className="share-comment-tags">
                    <span>常用评论</span>
                    <div>
                      {(space?.recent_share_comments || []).map((item) => (
                        <button key={item.id} className="tag-button" type="button" onClick={() => setShareComment(item.comment)}>
                          {item.comment}
                        </button>
                      ))}
                    </div>
                  </aside>
                </div>
                <div className="sentence-actions">
                  <button className="runtime-action compact" onClick={onShareSentence} disabled={sentenceBusy}>
                    <Send size={15} />
                    <span>发送</span>
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

  async function onSaveProfile() {
    if (isProfileLocked) {
      setProfileError("请先登录云同步账号后再编辑个人信息。");
      return;
    }
    setLoading(true);
    setProfileError("");
    try {
      setProfile(await saveProfile(profile));
      setSpace(await fetchDramaSpace());
    } catch (err) {
      setProfileError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onSelectPresetAvatar(avatar: PresetAvatar) {
    if (isProfileLocked) {
      setProfileError("请先登录云同步账号后再编辑个人信息。");
      return;
    }
    setAvatarSelectingId(avatar.id);
    setProfileError("");
    try {
      const dataUrl = await imageUrlToDataUrl(avatar.fullUrl);
      setProfile((current) => ({ ...current, avatar_data_url: dataUrl }));
      setSelectedPresetAvatarId(avatar.id);
    } catch (err) {
      setProfileError(String((err as Error).message || err));
    } finally {
      setAvatarSelectingId("");
    }
  }

  async function onLoginSync() {
    setLoading(true);
    setSyncError("");
    setProfileError("");
    try {
      setSyncConfig(await loginSync(loginForm.serverUrl, loginForm.username, loginForm.password));
      const [profileRes, spaceRes] = await Promise.all([fetchProfile(), fetchDramaSpace()]);
      setProfile(profileRes);
      setShowLoginModal(false);
      setSpace(spaceRes);
    } catch (err) {
      setSyncError(normalizeSyncAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  async function onRegisterSync() {
    setLoading(true);
    setSyncError("");
    setProfileError("");
    try {
      setSyncConfig(await registerSync(loginForm.serverUrl, loginForm.username, loginForm.password, loginForm.inviteCode));
      const [profileRes, spaceRes] = await Promise.all([fetchProfile(), fetchDramaSpace()]);
      setProfile(profileRes);
      setShowRegisterModal(false);
      setSpace(spaceRes);
    } catch (err) {
      setSyncError(normalizeSyncAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  async function onLogoutSync() {
    setLoading(true);
    setProfileError("");
    try {
      setSyncConfig(await logoutSync());
      setProfile(await fetchProfile());
      setSpace(await fetchDramaSpace());
    } catch (err) {
      setProfileError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onUpdateAutoSyncInterval(intervalMinutes: number) {
    setLoading(true);
    setProfileError("");
    try {
      setSyncConfig(await updateSyncConfig({ auto_sync_interval_minutes: intervalMinutes }));
    } catch (err) {
      setProfileError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onToggleLaunchAtLogin(enabled: boolean) {
    setDesktopSettingBusy(true);
    setDesktopSettingsError("");
    try {
      if (window.wordbookDesktop?.setLaunchAtLogin) {
        const next = await window.wordbookDesktop.setLaunchAtLogin(enabled);
        setLaunchAtLogin(Boolean(next));
      } else {
        setLaunchAtLogin(enabled);
      }
    } catch (err) {
      setDesktopSettingsError(String((err as Error).message || err));
    } finally {
      setDesktopSettingBusy(false);
    }
  }

  async function onUpdateNotificationWindow(partial: Partial<DesktopSettings>) {
    setDesktopSettingBusy(true);
    setDesktopSettingsError("");
    try {
      const saved = await updateDesktopSettings(partial);
      setDesktopSettings(saved);
    } catch (err) {
      setDesktopSettingsError(String((err as Error).message || err));
    } finally {
      setDesktopSettingBusy(false);
    }
  }

  async function onCreatePartnerRequest() {
    const target = partnerRequestName.trim();
    if (!target || !space?.can_send_partner_request) return;
    setPartnerBusy(true);
    setSpaceError("");
    try {
      await createPartnerRequest(target);
      setPartnerRequestName("");
      setSpace(await fetchDramaSpace());
    } catch (err) {
      setSpaceError(normalizeSpaceError(err));
    } finally {
      setPartnerBusy(false);
    }
  }

  async function onAcceptPartnerRequest(requestId: number) {
    setPartnerBusy(true);
    setSpaceError("");
    try {
      await acceptPartnerRequest(requestId);
      setSpace(await fetchDramaSpace());
    } catch (err) {
      setSpaceError(normalizeSpaceError(err));
    } finally {
      setPartnerBusy(false);
    }
  }

  async function onRunSync() {
    setLoading(true);
    setProfileError("");
    try {
      const result = await runSync();
      if (result.state === "needs_pull") {
        const conflictCount = Number((result.conflicts || []).length || 0);
        const hint = conflictCount > 0 ? `，其中 ${conflictCount} 条需要你选择处理方式` : "";
        setProfileError((result.message || "云端有新变化，请先下载云端更新") + hint);
        const conflictsRes = await fetchSyncConflicts().catch(() => ({ items: [] as SyncConflict[] }));
        setSyncConflicts(conflictsRes.items || []);
        return;
      }
      setSyncConfig(await fetchSyncConfig());
      setSyncConflicts([]);
      setSpace(await fetchDramaSpace());
    } catch (err) {
      setProfileError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function onPullSync() {
    setLoading(true);
    setProfileError("");
    try {
      const result = await pullSync();
      if (result.state === "conflict") {
        const conflictCount = Number((result.conflicts || []).length || 0);
        setProfileError((result.message || "发现内容冲突，请先选择处理方式") + (conflictCount ? `（${conflictCount} 条）` : ""));
        const conflictsRes = await fetchSyncConflicts().catch(() => ({ items: [] as SyncConflict[] }));
        setSyncConflicts(conflictsRes.items || []);
        return;
      }
      setSyncConfig(await fetchSyncConfig());
      setSyncConflicts([]);
      setSpace(await fetchDramaSpace());
    } catch (err) {
      setProfileError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshSyncConflicts() {
    if (!syncConfig.access_token) {
      setSyncConflicts([]);
      return;
    }
    try {
      const data = await fetchSyncConflicts();
      setSyncConflicts(data.items || []);
    } catch {
      setSyncConflicts([]);
    }
  }

  async function onResolveSyncConflict(conflict: SyncConflict, strategy: "keep_local" | "accept_remote") {
    if (!conflict.type || !conflict.uuid) return;
    const key = `${conflict.type}:${conflict.uuid}:${strategy}`;
    setResolvingConflictKey(key);
    setProfileError("");
    try {
      const next = await resolveSyncConflict(conflict.type, conflict.uuid, strategy);
      setSyncConflicts(next.items || []);
    } catch (err) {
      setProfileError(String((err as Error).message || err));
    } finally {
      setResolvingConflictKey("");
    }
  }

  async function onResolveAllSyncConflicts(strategy: "keep_local" | "accept_remote") {
    const pending = syncConflicts.filter((item) => !item.resolved_strategy);
    if (!pending.length) return;
    setResolvingConflictKey(`all:${strategy}`);
    setProfileError("");
    try {
      let latest = { items: syncConflicts };
      for (const item of pending) {
        latest = await resolveSyncConflict(item.type, item.uuid, strategy);
      }
      setSyncConflicts(latest.items || []);
    } catch (err) { 
      setProfileError(String((err as Error).message || err));
    } finally {
      setResolvingConflictKey("");
    }
  }

  function conflictTypeLabel(conflict: SyncConflict): string {
    if (conflict.type === "profile") return "个人资料";
    if (conflict.type === "sentences") return "句子";
    if (conflict.type === "vocab_items") return "词条";
    return "内容";
  }

  function conflictPreview(conflict: SyncConflict, source: "local" | "remote"): string {
    const changeType = source === "local" ? conflict.local_change : conflict.remote_change;
    const value = (source === "local" ? conflict.local_value : conflict.remote_value) || {};
    if (changeType === "deleted") return "已删除";
    if (conflict.type === "profile") {
      const nickname = String(value.nickname || "").trim();
      return nickname ? `昵称：${nickname}` : "个人信息有变化";
    }
    const ja = String(value.example_ja || "").trim();
    const zh = String(value.example_zh || "").trim();
    const surface = String(value.surface || value.dictionary_form || "").trim();
    const text = ja || surface || zh || "内容有变化";
    return text.length > 42 ? `${text.slice(0, 42)}...` : text;
  }

  function conflictFieldHints(conflict: SyncConflict): string {
    const local = conflict.local_value || {};
    const remote = conflict.remote_value || {};
    const hints: string[] = [];

    const addIfChanged = (label: string, l: unknown, r: unknown) => {
      const lv = JSON.stringify(l ?? null);
      const rv = JSON.stringify(r ?? null);
      if (lv !== rv) hints.push(label);
    };

    if (conflict.type === "profile") {
      addIfChanged("昵称", local.nickname, remote.nickname);
      addIfChanged("主题色", local.theme_color, remote.theme_color);
      addIfChanged("头像", local.avatar_data_url, remote.avatar_data_url);
    } else if (conflict.type === "sentences") {
      addIfChanged("日语句子", local.example_ja, remote.example_ja);
      addIfChanged("中文句子", local.example_zh, remote.example_zh);
      addIfChanged("标签", local.tags, remote.tags);
    } else if (conflict.type === "vocab_items") {
      addIfChanged("词面", local.surface, remote.surface);
      addIfChanged("原形", local.dictionary_form, remote.dictionary_form);
      addIfChanged("释义", local.meanings, remote.meanings);
      addIfChanged("例句(日语)", local.example_ja, remote.example_ja);
      addIfChanged("例句(中文)", local.example_zh, remote.example_zh);
      addIfChanged("标签", local.tags, remote.tags);
    }

    if (!hints.length) return "多处内容有变化";
    return `差异字段：${hints.join("、")}`;
  }

  function renderActivityGrid() {
    const ownActivity = new Map((space?.activity || []).map((item) => [item.day, item]));
    const partnerActivity = new Map((space?.partner?.activity || []).map((item) => [item.day, item]));
    const today = new Date();
    const days = Array.from({ length: 365 }, (_, index) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (364 - index));
      const key = d.toISOString().slice(0, 10);
      return { key, date: d, own: ownActivity.get(key), partner: partnerActivity.get(key) };
    });
    const hasPartner = Boolean(space?.partner?.username);
    const columnCount = Math.ceil(days.length / 7);
    const maxWords = Math.max(
      1,
      ...days.flatMap((day) => [Number(day.own?.word_count || 0), Number(day.partner?.word_count || 0)])
    );
    const levelFor = (count: number) => (count > 0 ? Math.max(1, Math.ceil((count / maxWords) * 4)) : 0);
    const monthLabels = days
      .map((day, index) => ({ day, index }))
      .filter(({ day, index }) => day.date.getDate() === 1 || index === 0)
      .map(({ day, index }) => ({
        key: `${day.key}-month`,
        label: `${day.date.getMonth() + 1}月`,
        column: Math.floor(index / 7) + 1,
      }));
    return (
      <div className="activity-board">
        <div className="activity-grid" style={{ "--activity-columns": columnCount } as CSSProperties}>
          {days.map((day) => {
            const ownCount = Number(day.own?.word_count || 0);
            const partnerCount = Number(day.partner?.word_count || 0);
            return (
              <span
                key={day.key}
                className={`activity-cell ${hasPartner ? "split" : ""}`}
                title={
                  hasPartner
                    ? `${day.key} · 你 ${ownCount} 词 · 搭子 ${partnerCount} 词`
                    : `${day.key} · ${ownCount} 词`
                }
              >
                <i className={`activity-half own level-${levelFor(ownCount)}`} />
                {hasPartner ? <i className={`activity-half partner level-${levelFor(partnerCount)}`} /> : null}
              </span>
            );
          })}
        </div>
        <div className="activity-months" style={{ "--activity-columns": columnCount } as CSSProperties}>
          {monthLabels.map((month) => (
            <span key={month.key} style={{ gridColumn: month.column }}>{month.label}</span>
          ))}
        </div>
      </div>
    );
  }

  function renderSpacePanel() {
    const ownRecent = space?.recent_series || playerNodes.slice(0, 8);
    const partnerRecent = space?.partner?.recent_series || [];
    const unreadShares = space?.unread_shares || [];
    const inboundRequests = space?.partner_inbound_requests || [];
    const outboundRequests = space?.partner_outbound_requests || [];
    const partner = space?.partner || null;
    const detailShare = shareDetailModalId !== null ? unreadShares.find((s) => s.id === shareDetailModalId) || null : null;
    return (
      <section className="space-pane">
        <section className="space-top-panel">
          <section className="space-activity-panel">
            <div className="section-title">
              <CalendarClock size={17} />
              <span>最近 365 天</span>
            </div>
            {renderActivityGrid()}
            <div className="activity-legend">
              <span>{profile.nickname}</span>
              {space?.partner?.username ? <span>{space.partner.profile?.nickname || space.partner.username}</span> : <span>未绑定搭子</span>}
            </div>
          </section>
          <section className="partner-panel">
            <div className="section-title">
              <Users size={17} />
              <span>搭子</span>
            </div>
            {partner ? (
              <div className="partner-card">
                <div className="partner-avatar">{partner.profile?.avatar_data_url ? <img src={partner.profile.avatar_data_url} alt={partner.username} /> : (partner.profile?.nickname || partner.username).slice(0, 1)}</div>
                <div className="partner-meta">
                  <strong>{partner.profile?.nickname || partner.username}</strong>
                  <span>@{partner.username}</span>
                  <small>{partner.last_login_at ? `上次登录 ${formatDate(partner.last_login_at)}` : "暂无登录记录"}</small>
                </div>
              </div>
            ) : (
              <div className="partner-request-form">
                <label>
                  <span>发送搭子申请</span>
                  <input
                    placeholder="输入对方用户名"
                    value={partnerRequestName}
                    onChange={(event) => setPartnerRequestName(event.target.value)}
                    disabled={!syncConfig.access_token || !space?.can_send_partner_request || partnerBusy}
                  />
                </label>
                <button
                  className="runtime-action compact"
                  onClick={onCreatePartnerRequest}
                  disabled={!syncConfig.access_token || !space?.can_send_partner_request || partnerBusy || !partnerRequestName.trim()}
                >
                  <Send size={15} />
                  <span>发送申请</span>
                </button>
                {!syncConfig.access_token ? <div className="empty">请先登录云同步账号。</div> : null}
                {syncConfig.access_token && !space?.can_send_partner_request ? (
                  <div className="empty">你已有搭子，不能再发起申请。</div>
                ) : null}
              </div>
            )}
            {inboundRequests.length ? (
              <div className="partner-request-list">
                {inboundRequests.map((request) => (
                  <article key={request.id} className="partner-request-card">
                    <div>
                      <strong>{request.from_profile?.nickname || request.from_username}</strong>
                      <span>@{request.from_username}</span>
                    </div>
                    <small>{formatDate(request.created_at)}</small>
                    <button className="runtime-action compact" onClick={() => onAcceptPartnerRequest(request.id)} disabled={partnerBusy || Boolean(partner)}>
                      <Users size={15} />
                      <span>接受申请</span>
                    </button>
                  </article>
                ))}
              </div>
            ) : null}
            {outboundRequests.length ? (
              <div className="partner-outbound-hint">
                已发送：{outboundRequests.map((entry) => `@${entry.to_username}`).join("、")}
              </div>
            ) : null}
          </section>
        </section>
        {spaceError ? (
          <div className="connection-card">
            <strong>操作未完成</strong>
            <span>{spaceError}</span>
          </div>
        ) : null}
        <section className="space-share-recent-row">
          <section className="unread-share-panel">
            <div className="section-title">
              <Send size={17} />
              <span>搭子分享</span>
            </div>
            <div className="unread-share-stack">
              {unreadShares.map((share) => {
                const myUser = syncConfig.username?.trim() || "";
                const isOwnThread = Boolean(myUser && share.sender_username === myUser);
                const replyCount = Array.isArray(share.replies) ? share.replies.length : 0;
                const detailOpen = shareDetailModalId === share.id;
                const jaFull = String(share.sentence?.example_ja || "").trim() || "未附带句子";
                const snippet = jaFull.length > 88 ? `${jaFull.slice(0, 86)}…` : jaFull;
                const senderLabel = share.sender_profile?.nickname || share.sender_username;
                const initials = senderLabel.trim().slice(0, 1) || "?";
                return (
                  <article className="unread-share-card" key={share.id}>
                    <div
                      className="share-compact-row"
                      role="button"
                      tabIndex={0}
                      aria-expanded={detailOpen}
                      onClick={() => setShareDetailModalId((prev) => (prev === share.id ? null : share.id))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setShareDetailModalId((prev) => (prev === share.id ? null : share.id));
                        }
                      }}
                    >
                      <div className="share-compact-avatar" aria-hidden>
                        {share.sender_profile?.avatar_data_url ? (
                          <img src={share.sender_profile.avatar_data_url} alt="" />
                        ) : (
                          initials
                        )}
                      </div>
                      <div className="share-compact-main">
                        <div className="share-compact-meta">
                          <strong>{senderLabel}</strong>
                          {isOwnThread ? <span className="share-thread-own">我发起的</span> : null}
                          <span className="share-compact-time">{formatDate(share.created_at)}</span>
                        </div>
                        <p className="share-compact-snippet">{snippet}</p>
                      </div>
                      <div
                        className="share-compact-tools"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="icon-button share-tool-btn"
                          title="跳转播放"
                          disabled={!share.sentence?.playback?.url}
                          onClick={() =>
                            openExternal(
                              withPlaybackTime(
                                String(share.sentence?.playback?.url || ""),
                                Number(share.sentence?.playback?.current_time || 0)
                              )
                            )
                          }
                        >
                          <ExternalLink size={16} />
                        </button>
                        <button type="button" className="icon-button share-tool-btn" title="收藏到我的句子" disabled={partnerBusy} onClick={() => onCollectShare(share)}>
                          <Save size={16} />
                        </button>
                        {!detailOpen ? (
                          <span className="share-comment-count-pill" title={`${replyCount} 条回复`}>
                            <MessageCircle size={16} />
                            <span>{replyCount}</span>
                          </span>
                        ) : null}
                        <span className="share-expand-chevron" aria-hidden>
                          {detailOpen ? <ChevronDown size={18} style={{ transform: "rotate(180deg)" }} /> : <ChevronDown size={18} />}
                        </span>
                      </div>
                    </div>
                  </article>
                );
              })}
              {!unreadShares.length ? <div className="empty centered share-empty-hint">暂无搭子分享动态。在扩展里保存句子并勾选分享给搭子后，会出现在这里。</div> : null}
            </div>
          </section>
          <section className="recent-series-panel">
            <div className="section-title">
              <Clapperboard size={17} />
              <span>最近在看</span>
            </div>
            <div className="series-grid">
              {ownRecent.length || partnerRecent.length ? [
                ...ownRecent.map((node) => ({ node, owner: "你" })),
                ...partnerRecent.map((node) => ({ node, owner: partner?.profile?.nickname || partner?.username || "搭子" })),
              ].map(({ node, owner }, idx) => {
                const shot = node.items.find((item) => item.screenshot_path);
                const canShowShot = owner === "你" && shot?.id;
                return (
                  <article className="series-card" key={`${owner}-${sourceKey(node)}-${idx}`}>
                    {canShowShot ? <img src={screenshotUrl(shot.id)} alt={node.series_name} /> : <div className="series-card-empty" />}
                    <em>{owner}</em>
                    <strong>{node.series_name}</strong>
                    <span>{node.episode_name}</span>
                    <small>{node.items.length} 条记录</small>
                  </article>
                );
              }) : <div className="empty centered">同步过带播放来源的句子或词条后会显示最近看的剧集。</div>}
            </div>
          </section>
        </section>
        {detailShare ? (
          <div
            className="modal-backdrop share-detail-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-detail-title"
            onClick={() => setShareDetailModalId(null)}
          >
            <div className="share-detail-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header share-detail-modal-header">
                <div className="section-title" id="share-detail-title">
                  <MessageCircle size={17} />
                  <span>分享详情 · {detailShare.sender_profile?.nickname || detailShare.sender_username}</span>
                </div>
                <button className="icon-button" type="button" onClick={() => setShareDetailModalId(null)} title="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className="share-detail-modal-scroll">
                {detailShare.has_screenshot ? (
                  <div className="share-detail-screenshot">
                    <img className="share-shot share-shot-hero" src={shareScreenshotUrl(detailShare, syncConfig.server_url || "")} alt="分享剧照" />
                  </div>
                ) : null}
                <div className="share-expanded-origin">
                  <div className="share-expanded-bilingual">
                    <p className="share-expanded-ja">
                      {String(detailShare.sentence?.example_ja || "").trim() || "未附带句子"}
                    </p>
                    {detailShare.sentence?.example_zh ? <p className="share-expanded-zh">{detailShare.sentence.example_zh}</p> : null}
                  </div>
                  <p className="share-expanded-note">
                    {(detailShare.comment || "").trim() ||
                      (syncConfig.username?.trim() && detailShare.sender_username === syncConfig.username.trim()
                        ? "已把这句台词分享给搭子。"
                        : "分享了一句台词给你。")}
                  </p>
                </div>
                <div className="share-thread-list" role="list">
                  {(detailShare.replies || []).length ? (
                    (detailShare.replies || []).map((reply) => (
                      <div className="share-thread-item" role="listitem" key={reply.id}>
                        <div className="share-thread-item-head">
                          <strong>{reply.sender_profile?.nickname || reply.sender_username}</strong>
                          <span>{formatDate(reply.created_at)}</span>
                        </div>
                        <p>{(reply.comment || "").trim() || "评论"}</p>
                      </div>
                    ))
                  ) : (
                    <div className="empty tiny">暂无回复，做第一个评论的人吧。</div>
                  )}
                </div>
                <div className="share-reply-box share-reply-box-expanded share-reply-box-modal">
                  <input
                    value={replyDraftByShare[detailShare.id] || ""}
                    placeholder="回复这条分享"
                    onChange={(event) => setReplyDraftByShare((current) => ({ ...current, [detailShare.id]: event.target.value }))}
                  />
                  <button type="button" className="icon-button share-tool-btn" title="发送回复" disabled={partnerBusy} onClick={() => onReplyShare(detailShare.id)}>
                    <Send size={16} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  function renderProfilePanel() {
    return (
      <section className="profile-pane">
        {!isProfileLocked ? (
          <section className="profile-card">
            <div className="section-title">
              <User size={17} />
              <span>个人信息</span>
            </div>
            <div className="avatar-row">
              <div className="avatar-preview">{profile.avatar_data_url ? <img src={profile.avatar_data_url} alt="avatar" /> : profile.nickname.slice(0, 1)}</div>
              <div className="avatar-tip">头像仅支持预设选择</div>
            </div>
            <div>
              <div className="field-title">
                <User size={15} />
                预选头像
              </div>
              <div className="avatar-preset-grid">
                {PRESET_AVATARS.map((avatar) => (
                  <button
                    key={avatar.id}
                    className={`avatar-preset-button ${selectedPresetAvatarId === avatar.id ? "active" : ""}`}
                    title={avatar.originalName}
                    onClick={() => onSelectPresetAvatar(avatar)}
                    disabled={loading || Boolean(avatarSelectingId)}
                  >
                    <img src={avatar.thumbUrl} alt={avatar.originalName} />
                  </button>
                ))}
              </div>
            </div>
            <label>
              <span>昵称</span>
              <input value={profile.nickname} onChange={(event) => setProfile({ ...profile, nickname: event.target.value })} disabled={loading} />
            </label>
            <label>
              <span>个性签名</span>
              <input
                value={profile.signature || ""}
                onChange={(event) => setProfile({ ...profile, signature: event.target.value })}
                placeholder="输入一句你的追剧宣言"
                disabled={loading}
              />
            </label>
            <div>
              <div className="field-title"><Palette size={15} />主题色</div>
              <div className="swatch-row">
                {THEME_COLORS.map((color) => (
                  <button
                    key={color}
                    className={`swatch ${profile.theme_color === color ? "active" : ""}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setProfile({ ...profile, theme_color: color })}
                    title={color}
                    disabled={loading}
                  />
                ))}
              </div>
            </div>
            <button className="runtime-action" onClick={onSaveProfile} disabled={loading}>
              <Save size={16} />
              <span>保存个人信息</span>
            </button>
          </section>
        ) : null}

        <section className="profile-card">
          <div className="section-title">
            <Cloud size={17} />
            <span>登录与同步</span>
          </div>
          {syncError ? (
            <div className="connection-card">
              <strong>操作未完成</strong>
              <span>{syncError}</span>
            </div>
          ) : null}
          {profileError ? (
            <div className="connection-card">
              <strong>操作未完成</strong>
              <span>{profileError}</span>
            </div>
          ) : null}
          <div className="sync-state">
            <strong>{syncConfig.username ? `已登录 ${syncConfig.username}` : "未登录"}</strong>
            <span>
              {syncConfig.last_sync_at
                ? `上次同步 ${formatDate(syncConfig.last_sync_at)} · 版本 ${syncConfig.last_server_version || 0}`
                : "登录后可同步句子、词条和图片引用"}
            </span>
          </div>
          <label>
            <span>自动同步间隔</span>
            <select
              value={String(syncConfig.auto_sync_interval_minutes || 0)}
              onChange={(event) => onUpdateAutoSyncInterval(Number(event.target.value))}
              disabled={loading || !syncConfig.access_token}
            >
              <option value="0">关闭</option>
              <option value="5">每 5 分钟</option>
              <option value="15">每 15 分钟</option>
              <option value="30">每 30 分钟</option>
              <option value="60">每 1 小时</option>
            </select>
          </label>
          {syncConflicts.length ? (
            <div className="sync-conflict-panel">
              <strong>需要你确认的内容（{syncConflicts.length}）</strong>
              <div className="sentence-actions">
                <button
                  className="runtime-action compact"
                  disabled={Boolean(resolvingConflictKey)}
                  onClick={() => onResolveAllSyncConflicts("keep_local")}
                >
                  <Save size={14} />
                  <span>全部使用这台设备内容</span>
                </button>
                <button
                  className="runtime-action secondary compact"
                  disabled={Boolean(resolvingConflictKey)}
                  onClick={() => onResolveAllSyncConflicts("accept_remote")}
                >
                  <Download size={14} />
                  <span>全部使用云端内容</span>
                </button>
              </div>
              <div className="sync-conflict-list">
                {syncConflicts.map((conflict) => {
                  const key = `${conflict.type}:${conflict.uuid}`;
                  return (
                    <article key={key} className="sync-conflict-item">
                      <div>
                        <strong>{conflictTypeLabel(conflict)}</strong>
                        <span>{conflict.local_change === "deleted" || conflict.remote_change === "deleted" ? "包含删除操作" : "内容不一致"}</span>
                      </div>
                      <small>这台设备：{conflictPreview(conflict, "local")} · 云端：{conflictPreview(conflict, "remote")}</small>
                      <small>{conflictFieldHints(conflict)}</small>
                      <div className="sentence-actions">
                        <button
                          className="runtime-action compact"
                          disabled={Boolean(resolvingConflictKey)}
                          onClick={() => onResolveSyncConflict(conflict, "keep_local")}
                        >
                          <Save size={14} />
                          <span>使用这台设备内容</span>
                        </button>
                        <button
                          className="runtime-action secondary compact"
                          disabled={Boolean(resolvingConflictKey)}
                          onClick={() => onResolveSyncConflict(conflict, "accept_remote")}
                        >
                          <Download size={14} />
                          <span>使用云端内容</span>
                        </button>
                      </div>
                      {conflict.resolved_strategy ? <em>已选择：{conflict.resolved_strategy === "keep_local" ? "这台设备内容" : "云端内容"}</em> : null}
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="sentence-actions">
            <button className="runtime-action" onClick={() => setShowLoginModal(true)} disabled={loading}>
              <LogIn size={16} />
              <span>登录</span>
            </button>
            <button className="runtime-action secondary" onClick={() => setShowRegisterModal(true)} disabled={loading}>
              <User size={16} />
              <span>注册</span>
            </button>
            <button className="runtime-action secondary" onClick={onRunSync} disabled={loading || !syncConfig.access_token}>
              <RefreshCw size={16} />
              <span>同步</span>
            </button>
            <button className="runtime-action secondary" onClick={onPullSync} disabled={loading || !syncConfig.access_token}>
              <Download size={16} />
              <span>下载云端更新</span>
            </button>
            <button className="runtime-action secondary" onClick={onLogoutSync} disabled={loading || !syncConfig.access_token}>
              <X size={16} />
              <span>登出</span>
            </button>
          </div>
        </section>

        <section className="profile-card">
          <div className="section-title">
            <Settings size={17} />
            <span>桌面提醒</span>
          </div>
          {desktopSettingsError ? (
            <div className="connection-card desktop-settings-error">
              <strong>设置保存失败</strong>
              <span>{desktopSettingsError}</span>
            </div>
          ) : null}
          <div className="desktop-settings-panel">
            <label className="setting-toggle">
              <span>开机启动</span>
              <input
                type="checkbox"
                checked={launchAtLogin}
                onChange={(event) => onToggleLaunchAtLogin(event.target.checked)}
                disabled={desktopSettingBusy}
              />
            </label>
            <label>
              <span>接收系统消息时间</span>
              <div className="time-window-row">
                <select
                  value={desktopSettings.notification_window_start}
                  onChange={(event) => onUpdateNotificationWindow({ notification_window_start: event.target.value })}
                  disabled={desktopSettingBusy}
                >
                  {START_HOUR_OPTIONS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
                <small>至</small>
                <select
                  value={desktopSettings.notification_window_end}
                  onChange={(event) => onUpdateNotificationWindow({ notification_window_end: event.target.value })}
                  disabled={desktopSettingBusy}
                >
                  {END_HOUR_OPTIONS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
            </label>
          </div>
        </section>
        {showLoginModal ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="sentence-edit-modal">
              <div className="modal-header">
                <div className="section-title">
                  <LogIn size={17} />
                  <span>登录云同步</span>
                </div>
                <button className="icon-button" onClick={() => setShowLoginModal(false)} title="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className="sentence-editor">
                <label>
                  <span>服务器地址（HTTP/HTTPS）</span>
                  <input placeholder="http://146.56.195.192" value={loginForm.serverUrl} onChange={(event) => setLoginForm({ ...loginForm, serverUrl: event.target.value })} />
                </label>
                <label>
                  <span>用户名</span>
                  <input value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} />
                </label>
                <label>
                  <span>密码</span>
                  <input type="password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} />
                </label>
                <div className="sentence-actions">
                  <button className="runtime-action compact" onClick={onLoginSync} disabled={loading}>
                    <LogIn size={15} />
                    <span>确认登录</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {showRegisterModal ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="sentence-edit-modal">
              <div className="modal-header">
                <div className="section-title">
                  <User size={17} />
                  <span>注册云同步</span>
                </div>
                <button className="icon-button" onClick={() => setShowRegisterModal(false)} title="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className="sentence-editor">
                <label>
                  <span>服务器地址（HTTP/HTTPS）</span>
                  <input placeholder="http://146.56.195.192" value={loginForm.serverUrl} onChange={(event) => setLoginForm({ ...loginForm, serverUrl: event.target.value })} />
                </label>
                <label>
                  <span>用户名</span>
                  <input value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} />
                </label>
                <label>
                  <span>密码（至少 8 位）</span>
                  <input type="password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} />
                </label>
                <label>
                  <span>邀请码</span>
                  <input value={loginForm.inviteCode} onChange={(event) => setLoginForm({ ...loginForm, inviteCode: event.target.value })} />
                </label>
                <div className="sentence-actions">
                  <button className="runtime-action compact" onClick={onRegisterSync} disabled={loading}>
                    <User size={15} />
                    <span>确认注册</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <div className="app-shell" style={appStyle}>
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
          <button className="icon-button" onClick={() => setView("profile")} title={syncConfig.username ? `已登录 ${syncConfig.username}` : "登录与设置"}>
            {syncConfig.username ? <User size={17} /> : <LogIn size={17} />}
          </button>
          <button className="icon-button" onClick={onRunSync} disabled={loading || !syncConfig.access_token} title="同步到服务器">
            <Cloud size={17} />
          </button>
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
          <button className={view === "space" ? "active" : ""} onClick={() => setView("space")} title="追剧空间">
            <Users size={19} />
          </button>
          <button className={view === "profile" ? "active" : ""} onClick={() => setView("profile")} title="个人信息">
            <Settings size={19} />
          </button>
          <button className={view === "runtime" ? "active" : ""} onClick={() => setView("runtime")} title="运行中心">
            <Terminal size={19} />
          </button>
        </aside>

        {view === "byPlayer" || view === "byTime" || view === "sentences" ? <section className="library-pane">
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

          {libraryError ? (
            <div className="connection-card">
              <strong>{sidecarStatus?.state === "starting" ? "本地服务正在启动" : "操作未完成"}</strong>
              <span>{libraryError}</span>
            </div>
          ) : null}

          <div className="scroll-area">{view === "byPlayer" ? renderSourceList() : view === "sentences" ? renderSentenceList() : renderTimeList()}</div>
        </section> : null}

        <section className={view === "runtime" || view === "space" || view === "profile" ? "detail-pane detail-pane-wide" : "detail-pane"}>
          {view === "runtime" ? renderRuntimePanel() : null}
          {view === "space" ? renderSpacePanel() : null}
          {view === "profile" ? renderProfilePanel() : null}
          {view === "sentences" ? renderSentencePanel() : null}
          {view !== "runtime" && view !== "space" && view !== "profile" ? (
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
                  {definitionLookupBusy ? (
                    <div className="token-dict-card muted">正在查询在线词典…</div>
                  ) : definitionOnlineLookup ? (
                    <div className="token-dict-card wordbook-online-dict">
                      <div className="wordbook-online-dict-label">在线词典</div>
                      <strong>{definitionOnlineLookup.lemma}</strong>
                      {definitionOnlineLookup.reading ? <span>{definitionOnlineLookup.reading}</span> : null}
                      {definitionOnlineLookup.jlpt_level ? <span className="jlpt-pill">{definitionOnlineLookup.jlpt_level}</span> : null}
                      {definitionOnlineLookup.meanings.length ? (
                        <ol>
                          {definitionOnlineLookup.meanings.map((meaning) => <li key={meaning}>{meaning}</li>)}
                        </ol>
                      ) : (
                        <p className="muted">未查到在线释义。</p>
                      )}
                    </div>
                  ) : selectedItems.length ? (
                    <div className="token-dict-card muted">暂无在线释义（可稍后重试或检查网络）</div>
                  ) : null}
                  <div className="word-title">
                    <h2>{selectedTitle}</h2>
                    {selectedItems[0]?.reading ? <span>{toHiragana(selectedItems[0].reading)}{accentMark(selectedItems[0].accent)}</span> : null}
                    {selectedItems[0]?.jlpt_level ? <span className="jlpt-pill">{selectedItems[0].jlpt_level}</span> : null}
                    <button className="icon-button word-speak-button" onClick={() => speakJapanese(selectedItems[0]?.dictionary_form || selectedTitle)} title="朗读词语">
                      <Volume2 size={15} />
                    </button>
                  </div>
                  <p className="muted wordbook-definition-hint">你在保存词语时填写的释义已显示在每个「例句」卡片中。</p>
                </>
              )}
            </section>
          </div> : null}

          {!selectedSource ? <section className="examples-panel">
            <div className="section-title">
              <BookOpen size={17} />
              <span>关联句子</span>
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
                    {(item.meanings || []).some((m) => String(m || "").trim()) ? (
                      <div className="example-user-meanings">
                        <strong>释义</strong>
                        <span>{(item.meanings || []).filter((m) => String(m || "").trim()).join("；")}</span>
                      </div>
                    ) : null}
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

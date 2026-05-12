export type VocabItem = {
  id: number;
  uuid?: string;
  head_id: number;
  surface: string;
  dictionary_form: string;
  reading: string;
  accent: number | null;
  jlpt_level: string;
  source: "manual" | "auto" | string;
  meanings: string[];
  example_ja: string;
  example_zh: string;
  screenshot_path: string | null;
  playback: {
    id: number;
    platform: string;
    url: string;
    title: string;
    current_time: number;
    duration: number;
    series_name: string;
    episode_name: string;
  } | null;
  sentence_id: number | null;
  tags: string[];
  created_at: string;
};

export type JaToken = {
  surface: string;
  dictionary_form: string;
  reading: string;
  accent: number | null;
  pos: string;
  jlpt_level: string;
  meanings: string[];
};

export type DictLookupResult = {
  lemma: string;
  reading: string;
  meanings: string[];
  jlpt_level?: string;
};

export type HealthStatus = {
  status: string;
  service: string;
  time: string;
  asr?: {
    available: boolean;
    loaded: boolean;
    preload: boolean;
    model_size: string;
    compute_type: string;
    download_root?: string;
    local_files_only?: boolean;
    hf_endpoint?: string;
    load_state?: {
      state: string;
      started_at: string | null;
      finished_at: string | null;
      error: string;
    };
    download_progress?: {
      downloaded_bytes: number;
      total_bytes: number;
      percent: number;
      cache_paths: string[];
    };
  };
};

export type AsrModelStatus = NonNullable<HealthStatus["asr"]>;

export type SidecarProcessStatus = {
  state: string;
  pid: number | null;
  managed: boolean;
  healthy: boolean;
  message: string;
  baseUrl: string;
  startedAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
};

export type PlayerNode = {
  platform: string;
  source: "manual" | "auto" | string;
  series_name: string;
  episode_name: string;
  items: VocabItem[];
};

export type SentenceRecord = {
  id: number;
  uuid?: string;
  example_ja: string;
  example_zh: string;
  tags: string[];
  source: "manual" | "auto" | string;
  screenshot_path: string | null;
  playback: VocabItem["playback"];
  word_count: number;
  created_at: string;
  updated_at: string;
};

export type Profile = {
  nickname: string;
  avatar_data_url: string;
  theme_color: string;
  signature?: string;
};

export type DesktopSettings = {
  notification_window_start: string;
  notification_window_end: string;
};

export type SyncConfig = {
  server_url: string;
  access_token: string;
  username: string;
  last_sync_at: string;
  last_server_version?: number;
  auto_sync_interval_minutes?: number;
};

export type SyncConflict = {
  type: "profile" | "sentences" | "vocab_items" | string;
  uuid: string;
  local_change?: string;
  remote_change?: string;
  local_value?: Record<string, unknown>;
  remote_value?: Record<string, unknown>;
  resolved_strategy?: "keep_local" | "accept_remote" | "";
};

export type DramaSpace = {
  profile: Profile;
  activity: Array<{ day: string; sentence_count: number; word_count: number }>;
  recent_series: PlayerNode[];
  total_words: number;
  partner: {
    username: string;
    profile: Partial<Profile>;
    last_login_at: string;
    recent_series?: PlayerNode[];
    activity?: Array<{ day: string; sentence_count: number; word_count: number }>;
  } | null;
  can_send_partner_request: boolean;
  partner_inbound_requests: Array<{
    id: number;
    created_at: string;
    from_username: string;
    from_profile: Partial<Profile>;
  }>;
  partner_outbound_requests: Array<{
    id: number;
    created_at: string;
    to_username: string;
  }>;
  /** Partner share threads: root shares you sent or received, with replies nested under `replies`. */
  unread_shares: Array<{
    id: number;
    sentence: SentenceRecord;
    comment: string;
    created_at: string;
    sender_username: string;
    sender_profile: Partial<Profile>;
    parent_share_id?: number;
    has_screenshot?: boolean;
    /** 同步服务器上的公开静态路径，供 <img> 直接加载（需与 server_url 拼接）。 */
    screenshot_media_url?: string | null;
    replies?: Array<{
      id: number;
      sentence: SentenceRecord;
      comment: string;
      created_at: string;
      sender_username: string;
      sender_profile: Partial<Profile>;
      parent_share_id?: number;
      has_screenshot?: boolean;
      screenshot_media_url?: string | null;
    }>;
  }>;
  recent_share_comments?: Array<{ id: number; comment: string; created_at: string }>;
};

export const SIDECAR_BASE = "http://127.0.0.1:17321";

/** 留空或未填时使用；与云端 Nginx/README 示例一致（可用环境变量在 sidecar 侧覆盖）。 */
export const DEFAULT_PUBLIC_SYNC_SERVER = "http://146.56.195.192";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SIDECAR_BASE}${path}`);
  if (!res.ok) {
    throw new Error(await parseApiError(res, `Request failed: ${res.status}`));
  }
  return (await res.json()) as T;
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  const text = (await res.text()).trim();
  if (!text) return fallback;
  try {
    const data = JSON.parse(text) as { detail?: string; message?: string; error?: string };
    return String(data.detail || data.message || data.error || fallback);
  } catch {
    return text || fallback;
  }
}

export async function fetchHealth(): Promise<HealthStatus> {
  return getJson<HealthStatus>("/health");
}

export async function fetchAsrStatus(): Promise<AsrModelStatus> {
  return getJson<AsrModelStatus>("/asr/status");
}

export async function startAsrModelLoad(): Promise<AsrModelStatus> {
  const res = await fetch(`${SIDECAR_BASE}/asr/model/load`, { method: "POST" });
  if (!res.ok) {
    throw new Error(await parseApiError(res, `Model load failed: ${res.status}`));
  }
  return (await res.json()) as AsrModelStatus;
}

export async function fetchByPlayer(): Promise<PlayerNode[]> {
  return getJson<PlayerNode[]>("/vocab/view/by-player");
}

export async function fetchByTime(): Promise<VocabItem[]> {
  const data = await getJson<{ items: VocabItem[] }>("/vocab/view/by-time?limit=200&offset=0");
  return data.items || [];
}

export async function fetchSentences(limit = 200, offset = 0): Promise<{ items: SentenceRecord[]; total: number }> {
  return getJson<{ items: SentenceRecord[]; total: number }>(`/sentences?limit=${limit}&offset=${offset}`);
}

export async function updateSentence(sentenceId: number, exampleJa: string, exampleZh: string, tags: string[]): Promise<SentenceRecord> {
  const res = await fetch(`${SIDECAR_BASE}/sentences/${sentenceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ example_ja: exampleJa, example_zh: exampleZh, tags }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `Sentence update failed: ${res.status}`));
  return (await res.json()) as SentenceRecord;
}

export async function deleteSentence(sentenceId: number): Promise<{ ok: boolean; deleted_sentence_id: number; deleted_word_count: number }> {
  const res = await fetch(`${SIDECAR_BASE}/sentences/${sentenceId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseApiError(res, `删除句子失败（${res.status}）`));
  return (await res.json()) as { ok: boolean; deleted_sentence_id: number; deleted_word_count: number };
}

export async function fetchDramaSpace(): Promise<DramaSpace> {
  return getJson<DramaSpace>("/space");
}

export async function fetchProfile(): Promise<Profile> {
  return getJson<Profile>("/profile");
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const res = await fetch(`${SIDECAR_BASE}/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `Profile save failed: ${res.status}`));
  return (await res.json()) as Profile;
}

export async function fetchDesktopSettings(): Promise<DesktopSettings> {
  return getJson<DesktopSettings>("/desktop/settings");
}

export async function updateDesktopSettings(payload: Partial<DesktopSettings>): Promise<DesktopSettings> {
  const res = await fetch(`${SIDECAR_BASE}/desktop/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `更新桌面设置失败（${res.status}）`));
  return (await res.json()) as DesktopSettings;
}

export async function fetchSyncConfig(): Promise<SyncConfig> {
  return getJson<SyncConfig>("/sync/config");
}

export async function updateSyncConfig(config: Pick<SyncConfig, "auto_sync_interval_minutes">): Promise<SyncConfig> {
  const res = await fetch(`${SIDECAR_BASE}/sync/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `更新同步设置失败（${res.status}）`));
  return (await res.json()) as SyncConfig;
}

export async function loginSync(serverUrl: string, username: string, password: string): Promise<SyncConfig> {
  const resolvedUrl = String(serverUrl ?? "").trim() || DEFAULT_PUBLIC_SYNC_SERVER;
  const res = await fetch(`${SIDECAR_BASE}/sync/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server_url: resolvedUrl, username, password }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `登录失败（${res.status}）`));
  return (await res.json()) as SyncConfig;
}

export async function registerSync(serverUrl: string, username: string, password: string, inviteCode = ""): Promise<SyncConfig> {
  const resolvedUrl = String(serverUrl ?? "").trim() || DEFAULT_PUBLIC_SYNC_SERVER;
  const res = await fetch(`${SIDECAR_BASE}/sync/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server_url: resolvedUrl, username, password, invite_code: inviteCode }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `注册失败（${res.status}）`));
  return (await res.json()) as SyncConfig;
}

export async function logoutSync(): Promise<SyncConfig> {
  const res = await fetch(`${SIDECAR_BASE}/sync/logout`, { method: "POST" });
  if (!res.ok) throw new Error(await parseApiError(res, `退出登录失败（${res.status}）`));
  return (await res.json()) as SyncConfig;
}

export async function runSync(): Promise<{ ok?: boolean; state?: string; synced_at?: string; message?: string; conflicts?: SyncConflict[] }> {
  const res = await fetch(`${SIDECAR_BASE}/sync/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction: "push_pull" }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `同步失败（${res.status}）`));
  return (await res.json()) as { ok?: boolean; state?: string; synced_at?: string; message?: string; conflicts?: SyncConflict[] };
}

export async function pullSync(): Promise<{ ok?: boolean; state?: string; latest_version?: number; message?: string; conflicts?: SyncConflict[] }> {
  const res = await fetch(`${SIDECAR_BASE}/sync/pull`, { method: "POST" });
  if (!res.ok) throw new Error(await parseApiError(res, `下载云端更新失败（${res.status}）`));
  return (await res.json()) as { ok?: boolean; state?: string; latest_version?: number; message?: string; conflicts?: SyncConflict[] };
}

export async function fetchSyncConflicts(): Promise<{ items: SyncConflict[]; at?: string }> {
  return getJson<{ items: SyncConflict[]; at?: string }>("/sync/conflicts");
}

export async function resolveSyncConflict(type: string, uuid: string, strategy: "keep_local" | "accept_remote"): Promise<{ items: SyncConflict[]; at?: string }> {
  const res = await fetch(`${SIDECAR_BASE}/sync/conflicts/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, uuid, strategy }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `处理不一致项失败（${res.status}）`));
  return (await res.json()) as { items: SyncConflict[]; at?: string };
}

export async function shareSentence(sentenceId: number, recipientUsername: string, comment: string): Promise<{ ok: boolean; id?: number }> {
  const res = await fetch(`${SIDECAR_BASE}/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentence_id: sentenceId, recipient_username: recipientUsername, comment }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `分享失败（${res.status}）`));
  return (await res.json()) as { ok: boolean; id?: number };
}

export async function replyShare(shareId: number, comment: string): Promise<{ ok: boolean; id?: number }> {
  const res = await fetch(`${SIDECAR_BASE}/shares/${shareId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `回复失败（${res.status}）`));
  return (await res.json()) as { ok: boolean; id?: number };
}

export async function collectShareSentence(share: DramaSpace["unread_shares"][number]): Promise<{ ok: boolean; sentence_id?: number }> {
  const res = await fetch(`${SIDECAR_BASE}/shares/${share.id}/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(share),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `收藏失败（${res.status}）`));
  return (await res.json()) as { ok: boolean; sentence_id?: number };
}

export async function createPartnerRequest(partnerUsername: string): Promise<{ ok: boolean; id?: number; status?: string }> {
  const res = await fetch(`${SIDECAR_BASE}/partner/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partner_username: partnerUsername }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, `发送申请失败（${res.status}）`));
  return (await res.json()) as { ok: boolean; id?: number; status?: string };
}

export async function acceptPartnerRequest(requestId: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${SIDECAR_BASE}/partner/requests/${requestId}/accept`, { method: "POST" });
  if (!res.ok) throw new Error(await parseApiError(res, `接受申请失败（${res.status}）`));
  return (await res.json()) as { ok: boolean };
}

export async function fetchHeadItems(headId: number): Promise<VocabItem[]> {
  return getJson<VocabItem[]>(`/vocab/heads/${headId}/items`);
}

export async function deleteVocabItem(itemId: number): Promise<void> {
  const res = await fetch(`${SIDECAR_BASE}/vocab/items/${itemId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, `删除失败（${res.status}）`));
  }
}

export async function updateVocabItemText(itemId: number, exampleJa: string, exampleZh: string): Promise<VocabItem> {
  const res = await fetch(`${SIDECAR_BASE}/vocab/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ example_ja: exampleJa, example_zh: exampleZh }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, `更新失败（${res.status}）`));
  }
  return (await res.json()) as VocabItem;
}

export async function tokenizeJapanese(text: string): Promise<JaToken[]> {
  const res = await fetch(`${SIDECAR_BASE}/ja/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, `分析失败（${res.status}）`));
  }
  const data = (await res.json()) as { tokens?: JaToken[] };
  return data.tokens || [];
}

export async function lookupDictionary(lemma: string): Promise<DictLookupResult> {
  let res: Response;
  try {
    res = await fetch(`${SIDECAR_BASE}/dict/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lemma }),
    });
  } catch (err) {
    throw new Error(`词典查询失败：无法连接 Sidecar 或网络不可用。${String((err as Error).message || err)}`);
  }
  if (!res.ok) {
    throw new Error(await parseApiError(res, `词典查询失败（${res.status}）`));
  }
  return (await res.json()) as DictLookupResult;
}

export async function deletePlayerGroup(node: PlayerNode): Promise<number> {
  const params = new URLSearchParams({
    platform: node.platform,
    source: node.source || "manual",
    series_name: node.series_name,
    episode_name: node.episode_name,
  });
  const res = await fetch(`${SIDECAR_BASE}/vocab/view/by-player?${params.toString()}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, `删除整集失败（${res.status}）`));
  }
  const data = (await res.json()) as { deleted_count?: number };
  return Number(data.deleted_count || 0);
}

export function screenshotUrl(itemId: number): string {
  return `${SIDECAR_BASE}/vocab/items/${itemId}/screenshot`;
}

export function sentenceScreenshotUrl(sentenceId: number): string {
  return `${SIDECAR_BASE}/sentences/${sentenceId}/screenshot`;
}

/** 同步服务器根地址，不含尾部斜杠（与登录配置一致）。 */
function normalizedSyncServerBase(raw: string): string {
  const t = String(raw || "").trim().replace(/\/+$/, "");
  return t;
}

export function shareScreenshotUrl(
  share: { id: number; screenshot_media_url?: string | null },
  serverUrl: string,
): string {
  const mediaPath = String(share?.screenshot_media_url || "").trim();
  const base = normalizedSyncServerBase(serverUrl);
  if (base && mediaPath.startsWith("/")) {
    return `${base}${mediaPath}`;
  }
  return `${SIDECAR_BASE}/shares/${share.id}/screenshot`;
}

export type ReviewQuestion = Record<string, unknown>;

export type ReviewStartResult = {
  session_id: string;
  resumed: boolean;
  calendar_day: string;
  cursor: number;
  total: number;
  current: ReviewQuestion | null;
  completed: boolean;
  empty_reason?: string;
};

export type ReviewAnswerResult = {
  done: boolean;
  correct: boolean;
  current: ReviewQuestion | null;
  hint_reading_after_wrong: boolean;
  reading_stage: string;
  head_state: { mastered?: boolean; distinct_days?: number; updated?: boolean };
  advanced?: boolean;
};

/** 本地日历日（浏览器时区）*/
export function localCalendarDay(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function fetchReviewSnapshot(): Promise<{ eligible_heads: number; mastered_heads: number }> {
  return getJson(`/review/snapshot`);
}

export async function postReviewStart(calendar_day: string, question_limit: number): Promise<ReviewStartResult> {
  const res = await fetch(`${SIDECAR_BASE}/review/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calendar_day, question_limit }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, `复习会话失败（${res.status}）`));
  }
  return (await res.json()) as ReviewStartResult;
}

export async function postReviewAnswer(body: {
  session_id: string;
  calendar_day: string;
  choice_index?: number;
  text?: string;
  order_piece_ids?: string[];
}): Promise<ReviewAnswerResult> {
  const res = await fetch(`${SIDECAR_BASE}/review/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, `提交答案失败（${res.status}）`));
  }
  return (await res.json()) as ReviewAnswerResult;
}

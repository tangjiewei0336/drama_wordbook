export type VocabItem = {
  id: number;
  head_id: number;
  surface: string;
  reading: string;
  jlpt_level: string;
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
  created_at: string;
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
  series_name: string;
  episode_name: string;
  items: VocabItem[];
};

export const SIDECAR_BASE = "http://127.0.0.1:17321";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SIDECAR_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
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
    throw new Error(`Model load failed: ${res.status}`);
  }
  return (await res.json()) as AsrModelStatus;
}

export async function fetchByPlayer(): Promise<PlayerNode[]> {
  return getJson<PlayerNode[]>("/vocab/view/by-player");
}

export async function fetchByTime(): Promise<VocabItem[]> {
  const data = await getJson<{ items: VocabItem[] }>("/vocab/view/by-time");
  return data.items || [];
}

export async function fetchHeadItems(headId: number): Promise<VocabItem[]> {
  return getJson<VocabItem[]>(`/vocab/heads/${headId}/items`);
}

export async function deleteVocabItem(itemId: number): Promise<void> {
  const res = await fetch(`${SIDECAR_BASE}/vocab/items/${itemId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`Delete failed: ${res.status}`);
  }
}

export function screenshotUrl(itemId: number): string {
  return `${SIDECAR_BASE}/vocab/items/${itemId}/screenshot`;
}

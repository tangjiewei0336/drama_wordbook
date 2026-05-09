export type VocabItem = {
  id: number;
  head_id: number;
  surface: string;
  reading: string;
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

export type PlayerNode = {
  platform: string;
  series_name: string;
  episode_name: string;
  items: VocabItem[];
};

const BASE = "http://127.0.0.1:17321";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
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

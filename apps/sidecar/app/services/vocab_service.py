from __future__ import annotations

import base64
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "db.sqlite3"
SCREENSHOT_DIR = Path(__file__).resolve().parent.parent / "data" / "screenshots"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    conn = _get_conn()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS vocab_head (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dictionary_form TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playback_context (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                url TEXT,
                title TEXT,
                current_time REAL,
                duration REAL,
                bvid TEXT,
                aid TEXT,
                cid TEXT,
                ep_id TEXT,
                part_index INTEGER,
                series_name TEXT,
                episode_name TEXT,
                video_title TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vocab_item (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                head_id INTEGER NOT NULL,
                surface TEXT NOT NULL,
                reading TEXT,
                meanings_json TEXT NOT NULL,
                example_ja TEXT,
                example_zh TEXT,
                screenshot_path TEXT,
                playback_context_id INTEGER,
                created_at TEXT NOT NULL,
                FOREIGN KEY(head_id) REFERENCES vocab_head(id),
                FOREIGN KEY(playback_context_id) REFERENCES playback_context(id)
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def _parse_series_episode(title: str) -> tuple[str, str]:
    text = (title or "").strip()
    if not text:
        return "Unknown", "Unknown"
    # Heuristic split: series - episode
    parts = re.split(r"\s*[-|丨｜]\s*", text, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    ep_match = re.search(r"(第?\s*\d+\s*[集话話])", text)
    if ep_match:
        idx = ep_match.start()
        series = text[:idx].strip() or text
        episode = text[idx:].strip()
        return series, episode
    return text, text


def _upsert_head(conn: sqlite3.Connection, dictionary_form: str) -> int:
    now = _utc_now()
    clean_df = dictionary_form.strip()
    row = conn.execute(
        "SELECT id FROM vocab_head WHERE dictionary_form = ?",
        (clean_df,),
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE vocab_head SET updated_at = ? WHERE id = ?",
            (now, int(row["id"])),
        )
        return int(row["id"])

    cur = conn.execute(
        "INSERT INTO vocab_head (dictionary_form, created_at, updated_at) VALUES (?, ?, ?)",
        (clean_df, now, now),
    )
    return int(cur.lastrowid)


def _insert_playback_context(conn: sqlite3.Connection, playback: dict | None) -> int | None:
    if not playback:
        return None
    now = _utc_now()
    platform = str(playback.get("platform", "bilibili"))
    title = str(playback.get("title", "") or "")
    series_name, episode_name = _parse_series_episode(title)
    cur = conn.execute(
        """
        INSERT INTO playback_context (
            platform, url, title, current_time, duration, bvid, aid, cid, ep_id, part_index,
            series_name, episode_name, video_title, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            platform,
            playback.get("url", ""),
            title,
            float(playback.get("current_time", 0.0) or 0.0),
            float(playback.get("duration", 0.0) or 0.0),
            playback.get("bvid"),
            playback.get("aid"),
            playback.get("cid"),
            playback.get("ep_id"),
            playback.get("p"),
            series_name,
            episode_name,
            title,
            now,
        ),
    )
    return int(cur.lastrowid)


def _save_screenshot_base64(data: str | None) -> str | None:
    if not data:
        return None
    now_key = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = SCREENSHOT_DIR / f"{now_key}.png"
    try:
        path.write_bytes(base64.b64decode(data))
        return str(path)
    except Exception:
        return None


def add_items(items: list[dict]) -> tuple[list[int], list[int]]:
    if not items:
        return [], []
    conn = _get_conn()
    head_ids: list[int] = []
    item_ids: list[int] = []
    try:
        for item in items:
            dictionary_form = str(item.get("dictionary_form", "") or "").strip()
            surface = str(item.get("surface", "") or "").strip()
            if not dictionary_form:
                dictionary_form = surface
            if not dictionary_form:
                continue

            head_id = _upsert_head(conn, dictionary_form)
            head_ids.append(head_id)

            playback_id = _insert_playback_context(conn, item.get("playback"))
            screenshot_path = _save_screenshot_base64(item.get("screenshot_base64"))
            cur = conn.execute(
                """
                INSERT INTO vocab_item (
                    head_id, surface, reading, meanings_json, example_ja, example_zh,
                    screenshot_path, playback_context_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    head_id,
                    surface or dictionary_form,
                    str(item.get("reading", "") or ""),
                    json.dumps(item.get("meanings") or [], ensure_ascii=False),
                    str(item.get("example_ja", "") or ""),
                    str(item.get("example_zh", "") or ""),
                    screenshot_path,
                    playback_id,
                    _utc_now(),
                ),
            )
            item_ids.append(int(cur.lastrowid))

        conn.commit()
    finally:
        conn.close()
    return sorted(set(head_ids)), item_ids


def get_heads() -> list[dict]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT h.id, h.dictionary_form, h.created_at, h.updated_at, COUNT(i.id) AS item_count
            FROM vocab_head h
            LEFT JOIN vocab_item i ON i.head_id = h.id
            GROUP BY h.id
            ORDER BY h.updated_at DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _row_to_item(row: sqlite3.Row) -> dict:
    playback = None
    if row["playback_id"] is not None:
        playback = {
            "id": row["playback_id"],
            "platform": row["platform"],
            "url": row["url"],
            "title": row["title"],
            "current_time": row["current_time"],
            "duration": row["duration"],
            "series_name": row["series_name"],
            "episode_name": row["episode_name"],
        }
    return {
        "id": int(row["id"]),
        "head_id": int(row["head_id"]),
        "surface": row["surface"] or "",
        "reading": row["reading"] or "",
        "meanings": json.loads(row["meanings_json"] or "[]"),
        "example_ja": row["example_ja"] or "",
        "example_zh": row["example_zh"] or "",
        "screenshot_path": row["screenshot_path"],
        "playback": playback,
        "created_at": row["created_at"],
    }


def get_head_items(head_id: int) -> list[dict]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT i.*, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name
            FROM vocab_item i
            LEFT JOIN playback_context p ON p.id = i.playback_context_id
            WHERE i.head_id = ?
            ORDER BY i.created_at DESC
            """,
            (head_id,),
        ).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def get_by_time() -> list[dict]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT i.*, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name
            FROM vocab_item i
            LEFT JOIN playback_context p ON p.id = i.playback_context_id
            ORDER BY i.created_at DESC
            """
        ).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def get_by_player() -> list[dict]:
    items = get_by_time()
    grouped: dict[tuple[str, str, str], list[dict]] = {}
    for item in items:
        playback = item.get("playback") or {}
        platform = playback.get("platform") or "unknown"
        series_name = playback.get("series_name") or playback.get("title") or "unknown"
        episode_name = playback.get("episode_name") or playback.get("title") or "unknown"
        key = (platform, series_name, episode_name)
        grouped.setdefault(key, []).append(item)

    result = []
    for (platform, series_name, episode_name), grouped_items in grouped.items():
        result.append(
            {
                "platform": platform,
                "series_name": series_name,
                "episode_name": episode_name,
                "items": grouped_items,
            }
        )
    result.sort(key=lambda x: (x["platform"], x["series_name"], x["episode_name"]))
    return result


def get_item_screenshot_path(item_id: int) -> Path | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT screenshot_path FROM vocab_item WHERE id = ?",
            (item_id,),
        ).fetchone()
    finally:
        conn.close()

    if not row or not row["screenshot_path"]:
        return None
    path = Path(row["screenshot_path"]).resolve()
    try:
        # Security: only allow files under managed screenshot directory.
        path.relative_to(SCREENSHOT_DIR.resolve())
    except Exception:
        return None
    if not path.exists() or not path.is_file():
        return None
    return path

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import sqlite3
import ssl
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest
from uuid import uuid4

from app.services.accent_service import lookup_pitch_accent
from app.services.jlpt_service import lookup_jlpt_entry, normalize_jlpt_level

def _resolve_data_root() -> Path:
    """Pick a user-writable data directory that survives app reinstall/upgrade.

    Priority:
      1. ``DRAMA_WORDBOOK_DATA_DIR`` — set by Electron to ``app.getPath('userData')``
         on packaged builds (macOS: ``~/Library/Application Support/Drama Wordbook``,
         Windows: ``%APPDATA%\\Drama Wordbook``, Linux: ``~/.config/Drama Wordbook``).
      2. Legacy in-bundle path ``apps/sidecar/app/`` — fine for dev (working tree),
         but inside the .app bundle on packaged installs, where it would be wiped
         on every reinstall. Treated only as a fallback / migration source.
    """
    explicit = os.environ.get("DRAMA_WORDBOOK_DATA_DIR", "").strip()
    if explicit:
        base = Path(explicit).expanduser().resolve()
        base.mkdir(parents=True, exist_ok=True)
        return base
    return Path(__file__).resolve().parent.parent


_LEGACY_DATA_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = _resolve_data_root()
DB_PATH = DATA_ROOT / "db.sqlite3"
SCREENSHOT_DIR = DATA_ROOT / "data" / "screenshots"


def _migrate_legacy_data_once() -> None:
    """Best-effort: copy old in-bundle db + screenshots into the new user-data
    location on first run after upgrading. No-op if the new DB already exists.
    """
    try:
        if DATA_ROOT == _LEGACY_DATA_ROOT:
            return
        if DB_PATH.exists():
            return
        legacy_db = _LEGACY_DATA_ROOT / "db.sqlite3"
        if legacy_db.exists():
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            import shutil

            shutil.copy2(legacy_db, DB_PATH)
        legacy_shots = _LEGACY_DATA_ROOT / "data" / "screenshots"
        if legacy_shots.exists() and not SCREENSHOT_DIR.exists():
            SCREENSHOT_DIR.parent.mkdir(parents=True, exist_ok=True)
            import shutil

            shutil.copytree(legacy_shots, SCREENSHOT_DIR, dirs_exist_ok=True)
    except Exception:
        # Never block boot on migration; user can recover from sync server.
        pass


_migrate_legacy_data_once()
DEFAULT_TAGS = ["kksk", "好搞笑", "高频词"]
SYNC_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="wordbook-sync")
DEFAULT_PROFILE = {
    "nickname": "Drama Learner",
    "avatar_data_url": "",
    "theme_color": "#2e8f76",
    "signature": "",
}
DEFAULT_SYNC_CONFIG = {
    "server_url": "",
    "access_token": "",
    "username": "",
    "last_sync_at": "",
    "last_server_version": 0,
    "auto_sync_interval_minutes": 0,
}
# Default public sync host when login/register omit server_url.
# Override: DRAMA_WORDBOOK_PUBLIC_SYNC_SERVER=http://your-host
_DEFAULT_SYNC_ENV = os.environ.get("DRAMA_WORDBOOK_PUBLIC_SYNC_SERVER", "").strip().rstrip("/")
DEFAULT_PUBLIC_SYNC_SERVER_URL = _DEFAULT_SYNC_ENV or "http://146.56.195.192"
ALLOWED_THEME_COLORS = {"#2e8f76", "#d65f4a", "#4f7cff", "#a85539", "#7c3aed", "#0f766e"}
DEFAULT_DESKTOP_SETTINGS = {
    "notification_window_start": "18:00",
    "notification_window_end": "24:00",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


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
                item_uuid TEXT UNIQUE,
                head_id INTEGER NOT NULL,
                sentence_id INTEGER,
                surface TEXT NOT NULL,
                reading TEXT,
                jlpt_level TEXT,
                source TEXT DEFAULT 'manual',
                meanings_json TEXT NOT NULL,
                example_ja TEXT,
                example_zh TEXT,
                screenshot_path TEXT,
                playback_context_id INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(head_id) REFERENCES vocab_head(id),
                FOREIGN KEY(sentence_id) REFERENCES sentence(id),
                FOREIGN KEY(playback_context_id) REFERENCES playback_context(id)
            );

            CREATE TABLE IF NOT EXISTS sentence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sentence_uuid TEXT NOT NULL UNIQUE,
                example_ja TEXT,
                example_zh TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]',
                source TEXT DEFAULT 'manual',
                screenshot_path TEXT,
                playback_context_id INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                sync_status TEXT DEFAULT 'pending',
                FOREIGN KEY(playback_context_id) REFERENCES playback_context(id)
            );

            CREATE TABLE IF NOT EXISTS app_setting (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        if not _column_exists(conn, "vocab_item", "sentence_id"):
            conn.execute("ALTER TABLE vocab_item ADD COLUMN sentence_id INTEGER")
        if not _column_exists(conn, "vocab_item", "jlpt_level"):
            conn.execute("ALTER TABLE vocab_item ADD COLUMN jlpt_level TEXT")
        if not _column_exists(conn, "vocab_item", "source"):
            conn.execute("ALTER TABLE vocab_item ADD COLUMN source TEXT DEFAULT 'manual'")
        if not _column_exists(conn, "vocab_item", "item_uuid"):
            conn.execute("ALTER TABLE vocab_item ADD COLUMN item_uuid TEXT")
        if not _column_exists(conn, "vocab_item", "updated_at"):
            conn.execute("ALTER TABLE vocab_item ADD COLUMN updated_at TEXT")
        _migrate_sentences(conn)
        _migrate_item_uuid_and_updated_at(conn)
        _migrate_review_tables(conn)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_item_uuid ON vocab_item(item_uuid)")
        conn.commit()
    finally:
        conn.close()


def clear_db() -> None:
    conn = _get_conn()
    try:
        conn.executescript(
            """
            DELETE FROM review_session;
            DELETE FROM review_head_state;
            DELETE FROM vocab_item;
            DELETE FROM vocab_head;
            DELETE FROM sentence;
            DELETE FROM playback_context;
            DELETE FROM sqlite_sequence WHERE name IN ('vocab_item', 'vocab_head', 'sentence', 'playback_context');
            """
        )
        conn.commit()
    finally:
        conn.close()


def _normalize_tags(tags: list[str] | None) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for tag in tags or []:
        clean = str(tag or "").strip()
        if clean and clean not in seen:
            seen.add(clean)
            result.append(clean)
    return result


def _migrate_sentences(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT i.id, i.example_ja, i.example_zh, i.source, i.screenshot_path, i.playback_context_id, i.created_at
        FROM vocab_item i
        WHERE i.sentence_id IS NULL
        ORDER BY i.id
        """
    ).fetchall()
    for row in rows:
        now = row["created_at"] or _utc_now()
        cur = conn.execute(
            """
            INSERT INTO sentence (
                sentence_uuid, example_ja, example_zh, tags_json, source, screenshot_path,
                playback_context_id, created_at, updated_at, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
            """,
            (
                hashlib.sha256(f"legacy:{row['id']}:{now}".encode("utf-8")).hexdigest(),
                row["example_ja"] or "",
                row["example_zh"] or "",
                json.dumps([], ensure_ascii=False),
                row["source"] or "manual",
                row["screenshot_path"],
                row["playback_context_id"],
                now,
                now,
            ),
        )
        conn.execute("UPDATE vocab_item SET sentence_id = ? WHERE id = ?", (int(cur.lastrowid), int(row["id"])))


def _migrate_review_tables(conn: sqlite3.Connection) -> None:
    from app.services.review_service import init_review_tables

    init_review_tables(conn)


def _migrate_item_uuid_and_updated_at(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT id, item_uuid, created_at, updated_at
        FROM vocab_item
        ORDER BY id
        """
    ).fetchall()
    for row in rows:
        item_uuid = str(row["item_uuid"] or "").strip()
        created_at = row["created_at"] or _utc_now()
        updated_at = row["updated_at"] or created_at
        if not item_uuid:
            item_uuid = hashlib.sha256(f"vocab-item:{row['id']}:{created_at}".encode("utf-8")).hexdigest()
        conn.execute(
            "UPDATE vocab_item SET item_uuid = ?, updated_at = ? WHERE id = ?",
            (item_uuid, updated_at, int(row["id"])),
        )


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


def _normalize_vocab_item(item: dict) -> dict:
    surface = str(item.get("surface", "") or "").strip()
    dictionary_form = str(item.get("dictionary_form", "") or "").strip() or surface
    reading = str(item.get("reading", "") or "").strip()
    skip_enrichment = bool(item.get("skip_enrichment"))
    if skip_enrichment:
        jlpt_entry = {}
    elif len(dictionary_form) > 1 and dictionary_form.endswith("な"):
        stripped_dictionary_form = dictionary_form[:-1]
        stripped_reading = reading[:-1] if len(reading) > 1 and reading.endswith(("な", "ナ")) else reading
        stripped_entry = lookup_jlpt_entry(stripped_dictionary_form, stripped_reading)
        if stripped_entry.get("level") or stripped_entry.get("meaning"):
            dictionary_form = stripped_dictionary_form
            reading = stripped_reading
            jlpt_entry = stripped_entry
        else:
            jlpt_entry = lookup_jlpt_entry(dictionary_form, reading)
    else:
        jlpt_entry = lookup_jlpt_entry(dictionary_form, reading)
    normalized = dict(item)
    normalized["surface"] = surface
    normalized["dictionary_form"] = dictionary_form
    normalized["reading"] = reading
    normalized["source"] = "auto" if str(item.get("source", "") or "").strip().lower() == "auto" else "manual"
    normalized["jlpt_level"] = "" if skip_enrichment else jlpt_entry.get("level", "") or normalize_jlpt_level(str(item.get("jlpt_level", "") or ""))
    if not skip_enrichment and jlpt_entry.get("meaning") and not normalized.get("meanings"):
        normalized["meanings"] = [jlpt_entry["meaning"]]
    return normalized


def _insert_playback_context(conn: sqlite3.Connection, playback: dict | None) -> int | None:
    if not playback:
        return None
    now = _utc_now()
    platform = str(playback.get("platform", "bilibili"))
    title = str(playback.get("title", "") or "")
    part_title = str(playback.get("part_title", "") or "").strip()
    series_name, episode_name = _parse_series_episode(title)
    if part_title:
        episode_name = part_title
    elif playback.get("p"):
        episode_name = f"P{int(playback.get('p') or 0)}"
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


def _has_duplicate_item(
    conn: sqlite3.Connection,
    *,
    head_id: int,
    example_ja: str,
    example_zh: str,
    playback: dict | None,
) -> bool:
    current_time = float((playback or {}).get("current_time", 0.0) or 0.0)
    title = str((playback or {}).get("title", "") or "")
    url = str((playback or {}).get("url", "") or "")
    rows = conn.execute(
        """
        SELECT i.id, p.current_time, p.title, p.url
        FROM vocab_item i
        LEFT JOIN playback_context p ON p.id = i.playback_context_id
        WHERE i.head_id = ?
          AND COALESCE(i.example_ja, '') = ?
          AND COALESCE(i.example_zh, '') = ?
        ORDER BY i.id DESC
        LIMIT 20
        """,
        (head_id, example_ja, example_zh),
    ).fetchall()
    for row in rows:
        row_time = float(row["current_time"] or 0.0)
        row_title = str(row["title"] or "")
        row_url = str(row["url"] or "")
        same_media = (title and row_title == title) or (url and row_url == url) or (not title and not url)
        if same_media and abs(row_time - current_time) <= 3.0:
            return True
    return False


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


def _insert_sentence(
    conn: sqlite3.Connection,
    *,
    example_ja: str,
    example_zh: str,
    tags: list[str] | None,
    source: str,
    screenshot_path: str | None,
    playback_id: int | None,
) -> int:
    now = _utc_now()
    fingerprint = json.dumps(
        {
            "ja": example_ja,
            "zh": example_zh,
            "screenshot": screenshot_path,
            "playback": playback_id,
            "at": now,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    cur = conn.execute(
        """
        INSERT INTO sentence (
            sentence_uuid, example_ja, example_zh, tags_json, source, screenshot_path,
            playback_context_id, created_at, updated_at, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        """,
        (
            hashlib.sha256(fingerprint.encode("utf-8")).hexdigest(),
            example_ja,
            example_zh,
            json.dumps(_normalize_tags(tags), ensure_ascii=False),
            source,
            screenshot_path,
            playback_id,
            now,
            now,
        ),
    )
    return int(cur.lastrowid)


def add_sentence(item: dict) -> int:
    conn = _get_conn()
    try:
        playback_id = _insert_playback_context(conn, item.get("playback"))
        screenshot_path = _save_screenshot_base64(item.get("screenshot_base64"))
        sentence_id = _insert_sentence(
            conn,
            example_ja=str(item.get("example_ja", "") or ""),
            example_zh=str(item.get("example_zh", "") or ""),
            tags=item.get("tags") or [],
            source=str(item.get("source", "manual") or "manual"),
            screenshot_path=screenshot_path,
            playback_id=playback_id,
        )
        conn.commit()
        return sentence_id
    finally:
        conn.close()


def add_items(items: list[dict]) -> tuple[list[int], list[int], list[int]]:
    if not items:
        return [], [], []
    conn = _get_conn()
    head_ids: list[int] = []
    item_ids: list[int] = []
    sentence_ids: list[int] = []
    screenshot_cache: dict[str, str | None] = {}
    try:
        for item in items:
            item = _normalize_vocab_item(item)
            dictionary_form = str(item.get("dictionary_form", "") or "").strip()
            surface = str(item.get("surface", "") or "").strip()
            if not dictionary_form:
                continue

            head_id = _upsert_head(conn, dictionary_form)
            head_ids.append(head_id)

            example_ja = str(item.get("example_ja", "") or "")
            example_zh = str(item.get("example_zh", "") or "")
            playback = item.get("playback")
            source = str(item.get("source", "manual") or "manual")
            if _has_duplicate_item(
                conn,
                head_id=head_id,
                example_ja=example_ja,
                example_zh=example_zh,
                playback=playback,
            ):
                continue

            screenshot_base64 = item.get("screenshot_base64")
            screenshot_key = hashlib.sha256(str(screenshot_base64).encode("utf-8")).hexdigest() if screenshot_base64 else ""
            if screenshot_key and screenshot_key not in screenshot_cache:
                screenshot_cache[screenshot_key] = _save_screenshot_base64(screenshot_base64)
            screenshot_path = screenshot_cache.get(screenshot_key)
            playback_id = _insert_playback_context(conn, playback)
            sentence_id = _insert_sentence(
                conn,
                example_ja=example_ja,
                example_zh=example_zh,
                tags=item.get("tags") or [],
                source=source,
                screenshot_path=screenshot_path,
                playback_id=playback_id,
            )

            cur = conn.execute(
                """
                INSERT INTO vocab_item (
                    item_uuid, head_id, sentence_id, surface, reading, jlpt_level, source, meanings_json, example_ja, example_zh,
                    screenshot_path, playback_context_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(item.get("uuid") or uuid4()),
                    head_id,
                    sentence_id,
                    surface or dictionary_form,
                    str(item.get("reading", "") or ""),
                    str(item.get("jlpt_level", "") or ""),
                    source,
                    json.dumps(item.get("meanings") or [], ensure_ascii=False),
                    example_ja,
                    example_zh,
                    screenshot_path,
                    playback_id,
                    _utc_now(),
                    _utc_now(),
                ),
            )
            item_ids.append(int(cur.lastrowid))
            sentence_ids.append(int(sentence_id))

        conn.commit()
    finally:
        conn.close()
    return sorted(set(head_ids)), item_ids, sentence_ids


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
        "uuid": row["item_uuid"] or "",
        "head_id": int(row["head_id"]),
        "surface": row["surface"] or "",
        "dictionary_form": row["dictionary_form"] or "",
        "reading": row["reading"] or "",
        "accent": lookup_pitch_accent(row["dictionary_form"] or row["surface"] or ""),
        "jlpt_level": row["jlpt_level"] or "",
        "source": row["source"] or "manual",
        "meanings": json.loads(row["meanings_json"] or "[]"),
        "example_ja": row["example_ja"] or "",
        "example_zh": row["example_zh"] or "",
        "screenshot_path": row["screenshot_path"],
        "playback": playback,
        "sentence_id": int(row["sentence_id"]) if "sentence_id" in row.keys() and row["sentence_id"] is not None else None,
        "sentence_uuid": row["sentence_uuid"] if "sentence_uuid" in row.keys() else "",
        "tags": json.loads(row["tags_json"] or "[]") if "tags_json" in row.keys() else [],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"] if "updated_at" in row.keys() else row["created_at"],
    }


def get_head_items(head_id: int) -> list[dict]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT i.*, h.dictionary_form, s.tags_json, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name, s.sentence_uuid
            FROM vocab_item i
            LEFT JOIN vocab_head h ON h.id = i.head_id
            LEFT JOIN sentence s ON s.id = i.sentence_id
            LEFT JOIN playback_context p ON p.id = i.playback_context_id
            WHERE i.head_id = ?
            ORDER BY i.created_at DESC
            """,
            (head_id,),
        ).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def get_by_time(limit: int = 100, offset: int = 0) -> list[dict]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT i.*, h.dictionary_form, s.tags_json, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name, s.sentence_uuid
            FROM vocab_item i
            LEFT JOIN vocab_head h ON h.id = i.head_id
            LEFT JOIN sentence s ON s.id = i.sentence_id
            LEFT JOIN playback_context p ON p.id = i.playback_context_id
            ORDER BY i.created_at DESC
            LIMIT ? OFFSET ?
            """
            ,
            (max(1, min(int(limit or 100), 500)), max(0, int(offset or 0))),
        ).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def get_vocab_count() -> int:
    conn = _get_conn()
    try:
        row = conn.execute("SELECT COUNT(*) AS count FROM vocab_item").fetchone()
        return int(row["count"] or 0)
    finally:
        conn.close()


def get_all_vocab_items() -> list[dict]:
    """All vocab rows for export (no pagination)."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT i.*, h.dictionary_form, s.tags_json, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name, s.sentence_uuid
            FROM vocab_item i
            LEFT JOIN vocab_head h ON h.id = i.head_id
            LEFT JOIN sentence s ON s.id = i.sentence_id
            LEFT JOIN playback_context p ON p.id = i.playback_context_id
            ORDER BY i.created_at DESC
            """
        ).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def get_all_sentences_flat() -> list[dict]:
    """All sentences for export (no pagination)."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT s.*, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name, COUNT(i.id) AS word_count
            FROM sentence s
            LEFT JOIN playback_context p ON p.id = s.playback_context_id
            LEFT JOIN vocab_item i ON i.sentence_id = s.id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            """
        ).fetchall()
        return [_row_to_sentence(r) for r in rows]
    finally:
        conn.close()


def _row_to_sentence(row: sqlite3.Row) -> dict:
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
        "uuid": row["sentence_uuid"] or "",
        "example_ja": row["example_ja"] or "",
        "example_zh": row["example_zh"] or "",
        "tags": json.loads(row["tags_json"] or "[]"),
        "source": row["source"] or "manual",
        "screenshot_path": row["screenshot_path"],
        "playback": playback,
        "word_count": int(row["word_count"] or 0),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_sentences(limit: int = 100, offset: int = 0) -> tuple[list[dict], int]:
    conn = _get_conn()
    try:
        total = int(conn.execute("SELECT COUNT(*) AS count FROM sentence").fetchone()["count"] or 0)
        rows = conn.execute(
            """
            SELECT s.*, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name, COUNT(i.id) AS word_count
            FROM sentence s
            LEFT JOIN playback_context p ON p.id = s.playback_context_id
            LEFT JOIN vocab_item i ON i.sentence_id = s.id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (max(1, min(int(limit or 100), 500)), max(0, int(offset or 0))),
        ).fetchall()
        return [_row_to_sentence(r) for r in rows], total
    finally:
        conn.close()


def get_sentence(sentence_id: int) -> dict | None:
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT s.*, p.id AS playback_id, p.platform, p.url, p.title, p.current_time, p.duration,
                   p.series_name, p.episode_name, COUNT(i.id) AS word_count
            FROM sentence s
            LEFT JOIN playback_context p ON p.id = s.playback_context_id
            LEFT JOIN vocab_item i ON i.sentence_id = s.id
            WHERE s.id = ?
            GROUP BY s.id
            """,
            (sentence_id,),
        ).fetchall()
        return _row_to_sentence(rows[0]) if rows else None
    finally:
        conn.close()


def update_sentence(sentence_id: int, example_ja: str, example_zh: str, tags: list[str] | None = None) -> bool:
    conn = _get_conn()
    try:
        if tags is None:
            cur = conn.execute(
                """
                UPDATE sentence
                SET example_ja = ?, example_zh = ?, updated_at = ?, sync_status = 'pending'
                WHERE id = ?
                """,
                (example_ja, example_zh, _utc_now(), sentence_id),
            )
        else:
            cur = conn.execute(
                """
                UPDATE sentence
                SET example_ja = ?, example_zh = ?, tags_json = ?, updated_at = ?, sync_status = 'pending'
                WHERE id = ?
                """,
                (example_ja, example_zh, json.dumps(_normalize_tags(tags), ensure_ascii=False), _utc_now(), sentence_id),
            )
        conn.execute("UPDATE vocab_item SET example_ja = ?, example_zh = ? WHERE sentence_id = ?", (example_ja, example_zh, sentence_id))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_sentence(sentence_id: int) -> dict:
    conn = _get_conn()
    screenshot_paths: set[str] = set()
    playback_ids: set[int] = set()
    head_ids: set[int] = set()
    try:
        row = conn.execute(
            "SELECT id, screenshot_path, playback_context_id FROM sentence WHERE id = ?",
            (sentence_id,),
        ).fetchone()
        if not row:
            return {"deleted": False, "deleted_word_count": 0}
        if row["screenshot_path"]:
            screenshot_paths.add(str(row["screenshot_path"]))
        if row["playback_context_id"] is not None:
            playback_ids.add(int(row["playback_context_id"]))

        item_rows = conn.execute(
            "SELECT id, head_id, screenshot_path, playback_context_id FROM vocab_item WHERE sentence_id = ?",
            (sentence_id,),
        ).fetchall()
        for item in item_rows:
            head_ids.add(int(item["head_id"]))
            if item["screenshot_path"]:
                screenshot_paths.add(str(item["screenshot_path"]))
            if item["playback_context_id"] is not None:
                playback_ids.add(int(item["playback_context_id"]))

        deleted_word_count = len(item_rows)
        conn.execute("DELETE FROM vocab_item WHERE sentence_id = ?", (sentence_id,))
        conn.execute("DELETE FROM sentence WHERE id = ?", (sentence_id,))

        for head_id in head_ids:
            remaining = conn.execute("SELECT COUNT(*) AS count FROM vocab_item WHERE head_id = ?", (head_id,)).fetchone()
            if int(remaining["count"] or 0) == 0:
                conn.execute("DELETE FROM vocab_head WHERE id = ?", (head_id,))

        for playback_id in playback_ids:
            remaining_items = conn.execute("SELECT COUNT(*) AS count FROM vocab_item WHERE playback_context_id = ?", (playback_id,)).fetchone()
            remaining_sentences = conn.execute("SELECT COUNT(*) AS count FROM sentence WHERE playback_context_id = ?", (playback_id,)).fetchone()
            if int(remaining_items["count"] or 0) == 0 and int(remaining_sentences["count"] or 0) == 0:
                conn.execute("DELETE FROM playback_context WHERE id = ?", (playback_id,))

        conn.commit()
    finally:
        conn.close()

    for screenshot_path in screenshot_paths:
        path = Path(screenshot_path).resolve()
        try:
            conn = _get_conn()
            try:
                remaining_items = conn.execute("SELECT COUNT(*) AS count FROM vocab_item WHERE screenshot_path = ?", (screenshot_path,)).fetchone()
                remaining_sentences = conn.execute("SELECT COUNT(*) AS count FROM sentence WHERE screenshot_path = ?", (screenshot_path,)).fetchone()
                if int(remaining_items["count"] or 0) > 0 or int(remaining_sentences["count"] or 0) > 0:
                    continue
            finally:
                conn.close()
            path.relative_to(SCREENSHOT_DIR.resolve())
            path.unlink(missing_ok=True)
        except Exception:
            pass
    return {"deleted": True, "deleted_word_count": deleted_word_count}


def get_sentence_screenshot_path(sentence_id: int) -> Path | None:
    conn = _get_conn()
    try:
        row = conn.execute("SELECT screenshot_path FROM sentence WHERE id = ?", (sentence_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row["screenshot_path"]:
        return None
    path = Path(row["screenshot_path"]).resolve()
    try:
        path.relative_to(SCREENSHOT_DIR.resolve())
    except Exception:
        return None
    return path if path.exists() and path.is_file() else None


def get_activity(days: int = 365) -> list[dict]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS sentence_count,
                   SUM(CASE WHEN word_count IS NULL THEN 0 ELSE word_count END) AS word_count
            FROM (
                SELECT s.created_at, COUNT(i.id) AS word_count
                FROM sentence s
                LEFT JOIN vocab_item i ON i.sentence_id = s.id
                GROUP BY s.id
            )
            GROUP BY day
            ORDER BY day DESC
            LIMIT ?
            """,
            (max(1, min(int(days or 365), 730)),),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _recent_series_from_items(items: list[dict], limit: int = 8) -> list[dict]:
    grouped: dict[tuple[str, str, str], list[dict]] = {}
    for item in items:
        playback = item.get("playback") or {}
        platform = playback.get("platform") or "unknown"
        series_name = playback.get("series_name") or playback.get("title") or "unknown"
        episode_name = playback.get("episode_name") or playback.get("title") or "unknown"
        key = (platform, series_name, episode_name)
        grouped.setdefault(key, []).append(item)

    nodes = []
    for (platform, series_name, episode_name), grouped_items in grouped.items():
        grouped_items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        nodes.append(
            {
                "platform": platform,
                "source": "mixed",
                "series_name": series_name,
                "episode_name": episode_name,
                "items": grouped_items,
            }
        )
    nodes.sort(
        key=lambda node: max((str(item.get("created_at") or "") for item in node["items"]), default=""),
        reverse=True,
    )
    return nodes[: max(1, min(int(limit or 8), 24))]


def get_recent_series(limit: int = 8) -> list[dict]:
    sentences, _ = get_sentences(limit=500, offset=0)
    sentence_items = []
    for sentence in sentences:
        item = dict(sentence)
        # The desktop recent-series card only knows how to render vocab screenshots.
        item["screenshot_path"] = ""
        item["surface"] = item.get("example_ja") or ""
        item["source"] = item.get("source") or "manual"
        sentence_items.append(item)
    return _recent_series_from_items(get_by_time(limit=500, offset=0) + sentence_items, limit)


def get_by_player() -> list[dict]:
    items = get_by_time(limit=500, offset=0)
    grouped: dict[tuple[str, str, str, str], list[dict]] = {}
    for item in items:
        playback = item.get("playback") or {}
        platform = playback.get("platform") or "unknown"
        source = item.get("source") or "manual"
        series_name = playback.get("series_name") or playback.get("title") or "unknown"
        episode_name = playback.get("episode_name") or playback.get("title") or "unknown"
        key = (platform, source, series_name, episode_name)
        grouped.setdefault(key, []).append(item)

    result = []
    for (platform, source, series_name, episode_name), grouped_items in grouped.items():
        result.append(
            {
                "platform": platform,
                "source": source,
                "series_name": series_name,
                "episode_name": episode_name,
                "items": grouped_items,
            }
        )
    result.sort(key=lambda x: (x["platform"], x["series_name"], x["episode_name"]))
    return result


def delete_player_group(platform: str, source: str, series_name: str, episode_name: str) -> int:
    items = get_by_time()
    target_ids = [
        int(item["id"])
        for item in items
        if (item.get("playback") or {}).get("platform", "unknown") == platform
        and (item.get("source") or "manual") == source
        and ((item.get("playback") or {}).get("series_name") or (item.get("playback") or {}).get("title") or "unknown") == series_name
        and ((item.get("playback") or {}).get("episode_name") or (item.get("playback") or {}).get("title") or "unknown") == episode_name
    ]
    deleted = 0
    for item_id in target_ids:
        if delete_item(item_id):
            deleted += 1
    return deleted


def update_item_text(item_id: int, example_ja: str, example_zh: str) -> bool:
    conn = _get_conn()
    try:
        cur = conn.execute(
            """
            UPDATE vocab_item
            SET example_ja = ?, example_zh = ?, updated_at = ?
            WHERE id = ?
            """,
            (example_ja, example_zh, _utc_now(), item_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_item(item_id: int) -> bool:
    conn = _get_conn()
    screenshot_path: str | None = None
    head_id: int | None = None
    playback_id: int | None = None
    try:
        row = conn.execute(
            """
            SELECT id, head_id, screenshot_path, playback_context_id
            FROM vocab_item
            WHERE id = ?
            """,
            (item_id,),
        ).fetchone()
        if not row:
            return False

        head_id = int(row["head_id"])
        playback_id = int(row["playback_context_id"]) if row["playback_context_id"] is not None else None
        screenshot_path = row["screenshot_path"]

        conn.execute("DELETE FROM vocab_item WHERE id = ?", (item_id,))

        if head_id is not None:
            remaining = conn.execute(
                "SELECT COUNT(*) AS count FROM vocab_item WHERE head_id = ?",
                (head_id,),
            ).fetchone()
            if int(remaining["count"]) == 0:
                conn.execute("DELETE FROM vocab_head WHERE id = ?", (head_id,))

        if playback_id is not None:
            remaining = conn.execute(
                "SELECT COUNT(*) AS count FROM vocab_item WHERE playback_context_id = ?",
                (playback_id,),
            ).fetchone()
            if int(remaining["count"]) == 0:
                conn.execute("DELETE FROM playback_context WHERE id = ?", (playback_id,))

        conn.commit()
    finally:
        conn.close()

    if screenshot_path:
        path = Path(screenshot_path).resolve()
        try:
            conn = _get_conn()
            try:
                remaining = conn.execute(
                    "SELECT COUNT(*) AS count FROM vocab_item WHERE screenshot_path = ?",
                    (screenshot_path,),
                ).fetchone()
                if int(remaining["count"]) > 0:
                    return True
            finally:
                conn.close()
            path.relative_to(SCREENSHOT_DIR.resolve())
            path.unlink(missing_ok=True)
        except Exception:
            pass
    return True


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


def _get_setting(key: str, default: dict) -> dict:
    conn = _get_conn()
    try:
        row = conn.execute("SELECT value_json FROM app_setting WHERE key = ?", (key,)).fetchone()
        if not row:
            return dict(default)
        value = json.loads(row["value_json"] or "{}")
        return {**default, **value}
    finally:
        conn.close()


def _set_setting(key: str, value: dict) -> dict:
    now = _utc_now()
    conn = _get_conn()
    try:
        conn.execute(
            """
            INSERT INTO app_setting (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            """,
            (key, json.dumps(value, ensure_ascii=False), now),
        )
        conn.commit()
        return value
    finally:
        conn.close()


def get_profile() -> dict:
    return _get_setting("profile", DEFAULT_PROFILE)


def is_sync_logged_in() -> bool:
    config = get_sync_config()
    return bool(str(config.get("server_url", "") or "").strip() and str(config.get("access_token", "") or "").strip())


def _normalized_profile(profile: dict, current: dict | None = None, merge_current: bool = True) -> dict:
    base = {**DEFAULT_PROFILE, **(current or {})} if merge_current else dict(DEFAULT_PROFILE)
    next_profile = {**base, **(profile or {})}
    next_profile.pop("partner_code", None)
    next_profile.pop("partner_nickname", None)
    next_profile.pop("partner_theme_color", None)
    if next_profile.get("theme_color") not in ALLOWED_THEME_COLORS:
        next_profile["theme_color"] = base.get("theme_color") or DEFAULT_PROFILE["theme_color"]
    return next_profile


def save_profile(profile: dict, require_login: bool = False, push_remote: bool = False) -> dict:
    if require_login and not is_sync_logged_in():
        raise ValueError("请先登录云同步账号后再编辑个人信息。")
    current = get_profile()
    next_profile = _normalized_profile(profile, current)
    if push_remote:
        _authed_request("/me/profile", next_profile, method="PUT")
    return _set_setting("profile", next_profile)


def get_sync_config() -> dict:
    return _get_setting("sync_config", DEFAULT_SYNC_CONFIG)


def save_sync_config(config: dict) -> dict:
    current = get_sync_config()
    return _set_setting("sync_config", {**current, **config})


def _normalize_notify_clock(value: str, *, end: bool = False) -> str:
    text = str(value or "").strip()
    if end and text == "24:00":
        return "24:00"
    if not re.fullmatch(r"\d{2}:\d{2}", text):
        return "24:00" if end else "18:00"
    hh, mm = text.split(":", 1)
    hour = int(hh)
    minute = int(mm)
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return "24:00" if end else "18:00"
    return f"{hour:02d}:{minute:02d}"


def get_desktop_settings() -> dict:
    raw = _get_setting("desktop_settings", DEFAULT_DESKTOP_SETTINGS)
    return {
        "notification_window_start": _normalize_notify_clock(raw.get("notification_window_start", "18:00"), end=False),
        "notification_window_end": _normalize_notify_clock(raw.get("notification_window_end", "24:00"), end=True),
    }


def save_desktop_settings(settings: dict) -> dict:
    current = get_desktop_settings()
    start_raw = settings.get("notification_window_start")
    end_raw = settings.get("notification_window_end")
    next_settings = {
        "notification_window_start": _normalize_notify_clock(
            start_raw if start_raw is not None else current.get("notification_window_start", "18:00"), end=False
        ),
        "notification_window_end": _normalize_notify_clock(
            end_raw if end_raw is not None else current.get("notification_window_end", "24:00"), end=True
        ),
    }
    return _set_setting("desktop_settings", next_settings)


def _reset_sync_session(config: dict | None = None) -> dict:
    next_config = {**DEFAULT_SYNC_CONFIG, **(config or {})}
    _set_setting("sync_snapshot", {"profile": {}, "sentences": [], "vocab_items": []})
    _set_setting("sync_pending_remote", {"remote_changes": {}, "latest_version": 0})
    _set_setting("sync_conflicts", {"items": [], "at": _utc_now()})
    _set_conflict_resolution_map({})
    return _set_setting("sync_config", next_config)


def _normalized_server_url(server_url: str, *, default_if_empty: str | None = None) -> str:
    clean = str(server_url or "").strip().rstrip("/")
    if not clean and default_if_empty:
        clean = str(default_if_empty or "").strip().rstrip("/")
    if not clean:
        return ""
    if "://" not in clean:
        clean = ("http://" + clean.lstrip("/")).rstrip("/")
    lowered = clean.lower()
    if not lowered.startswith("http://") and not lowered.startswith("https://"):
        raise ValueError("同步服务器地址仅支持 http:// 或 https:// 协议。")
    return clean.rstrip("/")


def _urlopen_no_proxy(req: urlrequest.Request, timeout: int = 20):
    opener = urlrequest.build_opener(
        urlrequest.ProxyHandler({}),
        urlrequest.HTTPSHandler(context=ssl.create_default_context()),
    )
    return opener.open(req, timeout=timeout)


def _http_error_detail(exc: urlerror.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8")
    except Exception:
        raw = ""
    if raw:
        try:
            payload = json.loads(raw)
            detail = str(payload.get("detail") or "").strip()
            if detail:
                return detail
        except Exception:
            text = raw.strip()
            if text:
                return text
    return f"HTTP {int(getattr(exc, 'code', 0) or 0)} 请求失败"


def _json_from_sync_http(req: urlrequest.Request, timeout: int = 15) -> dict:
    try:
        with _urlopen_no_proxy(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        raise ValueError(_http_error_detail(exc)) from exc
    except urlerror.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise ValueError(f"无法连接同步服务器（请检查地址、端口与网络）：{reason}") from exc


def refresh_profile_from_sync_server() -> dict:
    me = _authed_request("/me")
    remote_profile = me.get("profile") or {}
    return _set_setting("profile", _normalized_profile(remote_profile if isinstance(remote_profile, dict) else {}, merge_current=False))


def login_sync_server(server_url: str, username: str, password: str) -> dict:
    clean_url = _normalized_server_url(server_url, default_if_empty=DEFAULT_PUBLIC_SYNC_SERVER_URL)
    _reset_sync_session({"server_url": clean_url})
    body = json.dumps({"username": username, "password": password}).encode("utf-8")
    req = urlrequest.Request(
        f"{clean_url}/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    data = _json_from_sync_http(req, timeout=15)
    token = str(data.get("access_token") or "")
    if not token:
        raise ValueError("服务器没有返回 access_token。")
    config = _reset_sync_session({"server_url": clean_url, "access_token": token, "username": username})
    refresh_profile_from_sync_server()
    return config


def register_sync_server(server_url: str, username: str, password: str, invite_code: str = "") -> dict:
    clean_url = _normalized_server_url(server_url, default_if_empty=DEFAULT_PUBLIC_SYNC_SERVER_URL)
    _reset_sync_session({"server_url": clean_url})
    body = json.dumps({"username": username, "password": password, "invite_code": str(invite_code or "").strip()}).encode("utf-8")
    req = urlrequest.Request(
        f"{clean_url}/auth/register",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    data = _json_from_sync_http(req, timeout=15)
    token = str(data.get("access_token") or "")
    if not token:
        raise ValueError("服务器没有返回 access_token。")
    config = _reset_sync_session({"server_url": clean_url, "access_token": token, "username": username})
    refresh_profile_from_sync_server()
    return config


def logout_sync_server() -> dict:
    config = get_sync_config()
    server_url = str(config.get("server_url", "") or "").strip()
    token = str(config.get("access_token", "") or "").strip()
    cleared_config = _reset_sync_session({"server_url": server_url})
    if server_url and token:
        try:
            req = urlrequest.Request(
                f"{_normalized_server_url(server_url)}/auth/logout",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
                method="POST",
            )
            with _urlopen_no_proxy(req, timeout=10):
                pass
        except Exception:
            pass
    return cleared_config


def _sync_payload() -> dict:
    profile = dict(get_profile() or {})
    sentences, _ = get_sentences(limit=500, offset=0)
    vocab_items = get_by_time(limit=500, offset=0)
    normalized_sentences = []
    for item in sentences:
        row = dict(item)
        row["uuid"] = str(row.get("uuid") or row.get("sentence_uuid") or "")
        normalized_sentences.append(row)
    normalized_vocab = []
    for item in vocab_items:
        row = dict(item)
        row["uuid"] = str(row.get("uuid") or row.get("item_uuid") or "")
        normalized_vocab.append(row)
    return {
        "profile": profile,
        "sentences": normalized_sentences,
        "vocab_items": normalized_vocab,
    }


def _snapshot_index(snapshot: dict | None, entity_type: str) -> dict[str, dict]:
    items = (snapshot or {}).get(entity_type) or []
    if isinstance(items, dict):
        return {str(k): dict(v or {}) for k, v in items.items() if k}
    indexed: dict[str, dict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        uid = str(item.get("uuid") or "").strip()
        if not uid:
            continue
        indexed[uid] = dict(item)
    return indexed


def _entity_json(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _diff_snapshots(base_snapshot: dict | None, target_snapshot: dict | None) -> dict:
    result: dict[str, list[dict]] = {"created": [], "updated": [], "deleted": []}
    base_profile = dict((base_snapshot or {}).get("profile") or {})
    target_profile = dict((target_snapshot or {}).get("profile") or {})
    if _entity_json(base_profile) != _entity_json(target_profile):
        result["updated"].append({"type": "profile", "uuid": "profile"})
    for entity_type in ("sentences", "vocab_items"):
        before = _snapshot_index(base_snapshot, entity_type)
        after = _snapshot_index(target_snapshot, entity_type)
        for uid, item in after.items():
            if uid not in before:
                result["created"].append({"type": entity_type, "uuid": uid, "value": item})
            elif _entity_json(before[uid]) != _entity_json(item):
                result["updated"].append({"type": entity_type, "uuid": uid, "value": item})
        for uid in before:
            if uid not in after:
                result["deleted"].append({"type": entity_type, "uuid": uid})
    return result


def _change_summary(changes: dict) -> dict:
    return {
        "created": len(changes.get("created") or []),
        "updated": len(changes.get("updated") or []),
        "deleted": len(changes.get("deleted") or []),
    }


def _detect_conflicts(local_changes: dict, remote_changes: dict) -> list[dict]:
    local_map: dict[tuple[str, str], tuple[str, dict]] = {}
    for kind in ("created", "updated", "deleted"):
        for item in (local_changes.get(kind) or []):
            key = (str(item.get("type") or ""), str(item.get("uuid") or ""))
            if key[0] and key[1]:
                local_map[key] = (kind, dict(item.get("value") or {}))
    conflicts: list[dict] = []
    for kind in ("created", "updated", "deleted"):
        for item in (remote_changes.get(kind) or []):
            key = (str(item.get("type") or ""), str(item.get("uuid") or ""))
            if key in local_map and key[0] and key[1]:
                local_change, local_value = local_map[key]
                conflicts.append(
                    {
                        "type": key[0],
                        "uuid": key[1],
                        "local_change": local_change,
                        "remote_change": kind,
                        "local_value": local_value,
                        "remote_value": dict(item.get("value") or {}),
                    }
                )
    return conflicts


def _conflict_key(item: dict) -> str:
    return f"{str(item.get('type') or '')}:{str(item.get('uuid') or '')}"


def _get_conflict_resolution_map() -> dict[str, str]:
    raw = _get_setting("sync_conflict_resolutions", {"items": []}).get("items") or []
    result: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = _conflict_key(item)
        strategy = str(item.get("strategy") or "")
        if key != ":" and strategy in {"keep_local", "accept_remote"}:
            result[key] = strategy
    return result


def _set_conflict_resolution_map(resolved: dict[str, str]) -> None:
    items = []
    for key, strategy in sorted(resolved.items()):
        item_type, _, uid = key.partition(":")
        if item_type and uid and strategy in {"keep_local", "accept_remote"}:
            items.append({"type": item_type, "uuid": uid, "strategy": strategy})
    _set_setting("sync_conflict_resolutions", {"items": items, "at": _utc_now()})


def run_sync_once(direction: str = "push_pull") -> dict:
    config = get_sync_config()
    server_url = _normalized_server_url(config.get("server_url", ""))
    token = str(config.get("access_token", "") or "")
    if not server_url or not token:
        raise ValueError("请先登录同步服务器。")
    base_version = max(0, int(config.get("last_server_version") or 0))
    last_snapshot = _get_setting("sync_snapshot", {"profile": {}, "sentences": [], "vocab_items": []})
    current_snapshot = _sync_payload()
    local_changes = _diff_snapshots(last_snapshot, current_snapshot)
    payload = {
        "direction": direction,
        "base_version": base_version,
        "data": current_snapshot,
        "local_changes": local_changes,
    }
    req = urlrequest.Request(
        f"{server_url}/sync/push",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with _urlopen_no_proxy(req, timeout=30) as res:
            result = json.loads(res.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        detail = exc.read().decode("utf-8")
        try:
            payload_err = json.loads(detail)
        except Exception:
            payload_err = {"detail": detail}
        raise ValueError(str(payload_err.get("detail") or payload_err)) from exc

    if not result.get("ok") and result.get("state") == "needs_pull":
        remote_changes = result.get("remote_changes") or {}
        conflicts = _detect_conflicts(local_changes, remote_changes)
        _set_setting("sync_pending_remote", {"remote_changes": remote_changes, "latest_version": result.get("latest_version", base_version)})
        _set_conflict_resolution_map({})
        _set_setting("sync_conflicts", {"items": conflicts, "at": _utc_now()})
        return {
            "ok": False,
            "state": "needs_pull",
            "message": result.get("message") or "远端有更新，需先更新本地。",
            "local_changes": _change_summary(local_changes),
            "remote_changes": _change_summary(remote_changes),
            "conflicts": conflicts,
        }

    version = int(result.get("version") or base_version)
    save_sync_config({"last_sync_at": _utc_now(), "last_server_version": version})
    _set_setting("sync_snapshot", current_snapshot)
    _set_conflict_resolution_map({})
    _set_setting("sync_conflicts", {"items": [], "at": _utc_now()})
    return {
        "ok": True,
        "state": "synced",
        "version": version,
        "local_changes": _change_summary(local_changes),
        "partner": result.get("partner"),
    }


def _replace_local_from_snapshot(snapshot: dict) -> None:
    conn = _get_conn()
    try:
        conn.executescript(
            """
            DELETE FROM vocab_item;
            DELETE FROM vocab_head;
            DELETE FROM sentence;
            DELETE FROM playback_context;
            DELETE FROM sqlite_sequence WHERE name IN ('vocab_item', 'vocab_head', 'sentence', 'playback_context');
            """
        )
        sentence_id_by_uuid: dict[str, int] = {}
        for sentence in (snapshot.get("sentences") or []):
            if not isinstance(sentence, dict):
                continue
            sentence_uuid = str(sentence.get("uuid") or sentence.get("sentence_uuid") or uuid4())
            playback_id = _insert_playback_context(conn, sentence.get("playback"))
            created_at = str(sentence.get("created_at") or _utc_now())
            updated_at = str(sentence.get("updated_at") or created_at)
            cur = conn.execute(
                """
                INSERT INTO sentence (
                    sentence_uuid, example_ja, example_zh, tags_json, source, screenshot_path,
                    playback_context_id, created_at, updated_at, sync_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
                """,
                (
                    sentence_uuid,
                    str(sentence.get("example_ja") or ""),
                    str(sentence.get("example_zh") or ""),
                    json.dumps(_normalize_tags(sentence.get("tags") or []), ensure_ascii=False),
                    str(sentence.get("source") or "manual"),
                    sentence.get("screenshot_path"),
                    playback_id,
                    created_at,
                    updated_at,
                ),
            )
            sentence_id_by_uuid[sentence_uuid] = int(cur.lastrowid)

        for item in (snapshot.get("vocab_items") or []):
            if not isinstance(item, dict):
                continue
            dictionary_form = str(item.get("dictionary_form") or item.get("surface") or "").strip()
            if not dictionary_form:
                continue
            head_id = _upsert_head(conn, dictionary_form)
            playback_id = _insert_playback_context(conn, item.get("playback"))
            sentence_uuid = str(item.get("sentence_uuid") or "")
            sentence_id = sentence_id_by_uuid.get(sentence_uuid)
            created_at = str(item.get("created_at") or _utc_now())
            updated_at = str(item.get("updated_at") or created_at)
            conn.execute(
                """
                INSERT INTO vocab_item (
                    item_uuid, head_id, sentence_id, surface, reading, jlpt_level, source, meanings_json,
                    example_ja, example_zh, screenshot_path, playback_context_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(item.get("uuid") or item.get("item_uuid") or uuid4()),
                    head_id,
                    sentence_id,
                    str(item.get("surface") or dictionary_form),
                    str(item.get("reading") or ""),
                    str(item.get("jlpt_level") or ""),
                    str(item.get("source") or "manual"),
                    json.dumps(item.get("meanings") or [], ensure_ascii=False),
                    str(item.get("example_ja") or ""),
                    str(item.get("example_zh") or ""),
                    item.get("screenshot_path"),
                    playback_id,
                    created_at,
                    updated_at,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def pull_remote_changes() -> dict:
    config = get_sync_config()
    base_version = max(0, int(config.get("last_server_version") or 0))
    payload = _authed_request(f"/sync/changes?since_version={base_version}")
    latest_version = int(payload.get("latest_version") or base_version)
    snapshot = payload.get("snapshot") or {}
    local_snapshot = _sync_payload()
    last_snapshot = _get_setting("sync_snapshot", {"profile": {}, "sentences": [], "vocab_items": []})
    local_changes = _diff_snapshots(last_snapshot, local_snapshot)
    remote_changes = payload.get("changes") or {"created": [], "updated": [], "deleted": []}
    all_conflicts = _detect_conflicts(local_changes, remote_changes)
    resolved_map = _get_conflict_resolution_map()
    unresolved = [item for item in all_conflicts if _conflict_key(item) not in resolved_map]
    if unresolved:
        _set_setting("sync_conflicts", {"items": unresolved, "at": _utc_now()})
        return {
            "ok": False,
            "state": "conflict",
            "message": "检测到本地与远端同时修改，请先解决冲突。",
            "conflicts": unresolved,
            "latest_version": latest_version,
        }

    # Three-way merge: start from remote snapshot and replay local changes.
    merged = {
        "profile": dict((snapshot or {}).get("profile") or {}),
        "sentences": list((snapshot or {}).get("sentences") or []),
        "vocab_items": list((snapshot or {}).get("vocab_items") or []),
    }
    merged_maps = {
        "sentences": _snapshot_index(merged, "sentences"),
        "vocab_items": _snapshot_index(merged, "vocab_items"),
    }
    conflict_keys = {_conflict_key(item) for item in all_conflicts}

    def apply_local_change(kind: str, item: dict):
        change_type = str(item.get("type") or "")
        change_uuid = str(item.get("uuid") or "")
        key = f"{change_type}:{change_uuid}"
        if change_type == "profile" and change_uuid == "profile":
            if kind == "deleted":
                merged["profile"] = {}
            else:
                merged["profile"] = dict(item.get("value") or {})
            return
        if change_type not in {"sentences", "vocab_items"} or not change_uuid:
            return
        value = dict(item.get("value") or {})
        if kind == "deleted":
            merged_maps[change_type].pop(change_uuid, None)
        else:
            merged_maps[change_type][change_uuid] = value

    for kind in ("created", "updated", "deleted"):
        for item in (local_changes.get(kind) or []):
            key = _conflict_key(item)
            if key in conflict_keys:
                strategy = resolved_map.get(key, "")
                if strategy == "keep_local":
                    apply_local_change(kind, item)
                # accept_remote: keep remote snapshot as-is
            else:
                apply_local_change(kind, item)

    merged["sentences"] = [merged_maps["sentences"][uid] for uid in sorted(merged_maps["sentences"].keys())]
    merged["vocab_items"] = [merged_maps["vocab_items"][uid] for uid in sorted(merged_maps["vocab_items"].keys())]
    _replace_local_from_snapshot(merged)
    if isinstance(merged.get("profile"), dict):
        save_profile(merged.get("profile") or {})
    save_sync_config({"last_server_version": latest_version, "last_sync_at": _utc_now()})
    # Base snapshot tracks remote head; local merged changes stay as pending for next push.
    _set_setting("sync_snapshot", snapshot)
    _set_conflict_resolution_map({})
    _set_setting("sync_conflicts", {"items": [], "at": _utc_now()})
    return {"ok": True, "state": "pulled", "latest_version": latest_version, "applied_changes": _change_summary(remote_changes)}


def get_sync_conflicts() -> dict:
    raw = _get_setting("sync_conflicts", {"items": [], "at": ""})
    resolved = _get_conflict_resolution_map()
    items = []
    for item in (raw.get("items") or []):
        key = _conflict_key(item)
        items.append({**item, "resolved_strategy": resolved.get(key, "")})
    return {"items": items, "at": raw.get("at", "")}


def resolve_sync_conflict(item_type: str, item_uuid: str, strategy: str) -> dict:
    clean_type = str(item_type or "").strip()
    clean_uuid = str(item_uuid or "").strip()
    clean_strategy = str(strategy or "").strip()
    if clean_type not in {"profile", "sentences", "vocab_items"} or not clean_uuid:
        raise ValueError("冲突条目标识无效。")
    if clean_strategy not in {"keep_local", "accept_remote"}:
        raise ValueError("strategy 仅支持 keep_local / accept_remote。")
    conflicts = get_sync_conflicts().get("items") or []
    key = f"{clean_type}:{clean_uuid}"
    if key not in {_conflict_key(item) for item in conflicts}:
        raise ValueError("冲突条目不存在或已解决。")
    resolved = _get_conflict_resolution_map()
    resolved[key] = clean_strategy
    _set_conflict_resolution_map(resolved)
    return get_sync_conflicts()


def _authed_request(path: str, payload: dict | None = None, method: str = "GET") -> dict:
    config = get_sync_config()
    server_url = _normalized_server_url(config.get("server_url", ""))
    token = str(config.get("access_token", "") or "")
    if not server_url or not token:
        raise ValueError("请先登录同步服务器。")
    body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urlrequest.Request(
        f"{server_url}{path}",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method=method,
    )
    try:
        with _urlopen_no_proxy(req, timeout=20) as res:
            return json.loads(res.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        raise ValueError(_http_error_detail(exc)) from exc


def bind_partner_on_server(partner_username: str) -> dict:
    return _authed_request("/me/partner", {"partner_username": partner_username}, method="PUT")


def get_unread_shares() -> list[dict]:
    """Partner share threads from server (root messages + nested replies, including own outbound)."""
    try:
        return list((_authed_request("/shares/unread") or {}).get("items") or [])
    except Exception:
        return []


def get_partner_state() -> dict:
    try:
        return _authed_request("/partner/state")
    except Exception:
        return {"partner": None, "can_send_request": False, "inbound_requests": [], "outbound_requests": []}


def create_partner_request(partner_username: str) -> dict:
    return _authed_request("/partner/requests", {"partner_username": partner_username}, method="POST")


def accept_partner_request(request_id: int) -> dict:
    return _authed_request(f"/partner/requests/{int(request_id)}/accept", method="POST")


def share_sentence_to_partner(sentence_id: int, recipient_username: str = "", comment: str = "") -> dict:
    sentence = get_sentence(sentence_id)
    if not sentence:
        raise ValueError("句子不存在。")
    screenshot_base64 = ""
    screenshot_path = sentence.get("screenshot_path")
    if screenshot_path:
        try:
            screenshot_base64 = base64.b64encode(Path(str(screenshot_path)).read_bytes()).decode("utf-8")
        except Exception:
            screenshot_base64 = ""
    state = get_partner_state()
    partner_username = str((state.get("partner") or {}).get("username") or "").strip()
    recipient = recipient_username.strip() or partner_username
    if not recipient:
        raise ValueError("还没有绑定搭子。")
    return _authed_request(
        "/shares",
        {
            "recipient_username": recipient,
            "sentence": sentence,
            "comment": comment,
            "screenshot_base64": screenshot_base64,
        },
        method="POST",
    )


def get_recent_share_comments() -> list[dict]:
    try:
        return list((_authed_request("/shares/recent-comments") or {}).get("items") or [])
    except Exception:
        return []


def reply_share_message(share_id: int, comment: str) -> dict:
    text = str(comment or "").strip()
    if not text:
        raise ValueError("回复内容不能为空。")
    return _authed_request(f"/shares/{int(share_id)}/reply", {"comment": text}, method="POST")


def _authed_request_bytes(path: str, timeout: int = 20) -> bytes:
    config = get_sync_config()
    server_url = _normalized_server_url(config.get("server_url", ""))
    token = str(config.get("access_token", "") or "")
    if not server_url or not token:
        raise ValueError("请先登录同步服务器。")
    req = urlrequest.Request(
        f"{server_url}{path}",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    with _urlopen_no_proxy(req, timeout=timeout) as res:
        return res.read()


def fetch_share_screenshot_bytes(share_id: int) -> bytes:
    return _authed_request_bytes(f"/shares/{int(share_id)}/screenshot", timeout=25)


def collect_shared_sentence(share: dict) -> dict:
    sentence = dict((share or {}).get("sentence") or {})
    if not sentence:
        raise ValueError("分享里没有句子内容。")
    screenshot_base64 = ""
    if bool((share or {}).get("has_screenshot")):
        try:
            screenshot_base64 = base64.b64encode(fetch_share_screenshot_bytes(int(share.get("id") or 0))).decode("utf-8")
        except Exception:
            screenshot_base64 = ""
    sentence_id = add_sentence(
        {
            "example_ja": str(sentence.get("example_ja") or ""),
            "example_zh": str(sentence.get("example_zh") or ""),
            "tags": sentence.get("tags") or [],
            "source": str(sentence.get("source") or "manual"),
            "screenshot_base64": screenshot_base64,
            "playback": sentence.get("playback") if isinstance(sentence.get("playback"), dict) else None,
        }
    )
    return {"ok": True, "sentence_id": int(sentence_id)}


def schedule_sync(direction: str = "push_pull"):
    return SYNC_EXECUTOR.submit(run_sync_once, direction)

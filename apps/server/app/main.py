from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import secrets
import sqlite3
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

try:
    import psycopg
    from psycopg.rows import dict_row
except Exception:  # pragma: no cover - optional in local sqlite mode
    psycopg = None
    dict_row = None

DB_PATH = Path(__file__).resolve().parent.parent / "server.sqlite3"
SHARE_SCREENSHOT_DIR = Path(__file__).resolve().parent.parent / "share_uploads"
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
ADMIN_TOKEN = os.getenv("DRAMA_ADMIN_TOKEN", "drama-debug")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _database_backend() -> str:
    lower = DATABASE_URL.lower()
    if lower.startswith("postgres://") or lower.startswith("postgresql://") or lower.startswith("postgresql+psycopg://"):
        return "postgres"
    return "sqlite"


def _normalized_database_url() -> str:
    if DATABASE_URL.startswith("postgresql+psycopg://"):
        return "postgresql://" + DATABASE_URL[len("postgresql+psycopg://") :]
    if DATABASE_URL.startswith("postgres://"):
        return "postgresql://" + DATABASE_URL[len("postgres://") :]
    return DATABASE_URL


def _sql_params(query: str, params: Iterable[Any], backend: str) -> tuple[str, Iterable[Any]]:
    if backend != "postgres":
        return query, params
    return query.replace("?", "%s"), params


class DBCursor:
    def __init__(self, raw: Any):
        self._raw = raw
        self.lastrowid = getattr(raw, "lastrowid", None)

    @property
    def rowcount(self) -> int:
        return int(getattr(self._raw, "rowcount", -1))

    def fetchone(self):
        return self._raw.fetchone()

    def fetchall(self):
        return self._raw.fetchall()


class DBConnection:
    def __init__(self, raw: Any, backend: str):
        self.raw = raw
        self.backend = backend

    def __enter__(self) -> "DBConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            self.raw.commit()
        else:
            self.raw.rollback()
        self.raw.close()

    def execute(self, query: str, params: Iterable[Any] = ()):
        statement, normalized = _sql_params(query, params, self.backend)
        return DBCursor(self.raw.execute(statement, tuple(normalized)))

    def executescript(self, script: str) -> None:
        if self.backend == "sqlite":
            self.raw.executescript(script)
            return
        for statement in script.split(";"):
            sql = statement.strip()
            if sql:
                self.raw.execute(sql)


def conn() -> DBConnection:
    backend = _database_backend()
    if backend == "postgres":
        if psycopg is None:
            raise RuntimeError("DATABASE_URL points to PostgreSQL but psycopg is not installed")
        db = psycopg.connect(_normalized_database_url(), row_factory=dict_row)
        return DBConnection(db, "postgres")
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return DBConnection(db, "sqlite")


def _insert_and_get_id(db: DBConnection, statement: str, params: Iterable[Any]) -> int:
    if db.backend == "postgres":
        row = db.execute(f"{statement.strip().rstrip(';')} RETURNING id", params).fetchone()
        if not row:
            raise RuntimeError("INSERT RETURNING id returned no row")
        return int(row["id"])
    cur = db.execute(statement, params)
    return int(cur.lastrowid or 0)


def _is_unique_violation(exc: Exception) -> bool:
    if isinstance(exc, sqlite3.IntegrityError):
        return True
    if psycopg is not None:
        unique_exc = getattr(psycopg.errors, "UniqueViolation", None)
        if unique_exc is not None and isinstance(exc, unique_exc):
            return True
    return "unique" in str(exc).lower()


def init_db() -> None:
    SHARE_SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    with conn() as db:
        if db.backend == "postgres":
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS "user" (
                    id BIGSERIAL PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    token_hash TEXT,
                    profile_json TEXT NOT NULL DEFAULT '{}',
                    partner_username TEXT DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_snapshot (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL REFERENCES "user"(id),
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_commit (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL REFERENCES "user"(id),
                    version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(user_id, version)
                );

                CREATE TABLE IF NOT EXISTS share_message (
                    id BIGSERIAL PRIMARY KEY,
                    sender_id BIGINT NOT NULL REFERENCES "user"(id),
                    recipient_id BIGINT NOT NULL REFERENCES "user"(id),
                    sentence_json TEXT NOT NULL,
                    comment TEXT NOT NULL DEFAULT '',
                    screenshot_path TEXT NOT NULL DEFAULT '',
                    parent_share_id BIGINT,
                    read_at TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS partner_request (
                    id BIGSERIAL PRIMARY KEY,
                    from_user_id BIGINT NOT NULL REFERENCES "user"(id),
                    to_user_id BIGINT NOT NULL REFERENCES "user"(id),
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    responded_at TEXT
                );

                CREATE TABLE IF NOT EXISTS invite_code (
                    id BIGSERIAL PRIMARY KEY,
                    code TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    used_by_username TEXT NOT NULL DEFAULT '',
                    used_at TEXT
                );
                """
            )
            cols = {
                row["column_name"]
                for row in db.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_name = 'user'"
                ).fetchall()
            }
            share_cols = {
                row["column_name"]
                for row in db.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_name = 'share_message'"
                ).fetchall()
            }
        else:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS "user" (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    token_hash TEXT,
                    profile_json TEXT NOT NULL DEFAULT '{}',
                    partner_username TEXT DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_snapshot (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES "user"(id)
                );

                CREATE TABLE IF NOT EXISTS sync_commit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES "user"(id),
                    UNIQUE(user_id, version)
                );

                CREATE TABLE IF NOT EXISTS share_message (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender_id INTEGER NOT NULL,
                    recipient_id INTEGER NOT NULL,
                    sentence_json TEXT NOT NULL,
                    comment TEXT NOT NULL DEFAULT '',
                    screenshot_path TEXT NOT NULL DEFAULT '',
                    parent_share_id INTEGER,
                    read_at TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(sender_id) REFERENCES "user"(id),
                    FOREIGN KEY(recipient_id) REFERENCES "user"(id)
                );

                CREATE TABLE IF NOT EXISTS partner_request (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_user_id INTEGER NOT NULL,
                    to_user_id INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    responded_at TEXT,
                    FOREIGN KEY(from_user_id) REFERENCES "user"(id),
                    FOREIGN KEY(to_user_id) REFERENCES "user"(id)
                );

                CREATE TABLE IF NOT EXISTS invite_code (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    used_by_username TEXT NOT NULL DEFAULT '',
                    used_at TEXT
                );
                """
            )
            cols = {row["name"] for row in db.execute('PRAGMA table_info("user")').fetchall()}
            share_cols = {row["name"] for row in db.execute("PRAGMA table_info(share_message)").fetchall()}
        if "last_login_at" not in cols:
            db.execute('ALTER TABLE "user" ADD COLUMN last_login_at TEXT')
        if "screenshot_path" not in share_cols:
            db.execute("ALTER TABLE share_message ADD COLUMN screenshot_path TEXT DEFAULT ''")
        if "parent_share_id" not in share_cols:
            db.execute("ALTER TABLE share_message ADD COLUMN parent_share_id INTEGER")


def password_hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 180_000).hex()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _normalize_invite_code(code: str) -> str:
    return str(code or "").strip().upper()


def _generate_invite_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(alphabet[int(secrets.randbelow(len(alphabet)))] for _ in range(10))


def _save_share_screenshot(data: str) -> str:
    clean = str(data or "").strip()
    if not clean:
        return ""
    try:
        raw = base64.b64decode(clean)
    except Exception:
        return ""
    name = f"{secrets.token_hex(16)}.png"
    path = SHARE_SCREENSHOT_DIR / name
    try:
        path.write_bytes(raw)
    except Exception:
        return ""
    return name


def _share_to_response(row: dict, replies: list[dict] | None = None) -> dict:
    payload = {
        "id": int(row["id"]),
        "sentence": json.loads(row["sentence_json"] or "{}"),
        "comment": row["comment"] or "",
        "created_at": row["created_at"],
        "sender_username": row["sender_username"],
        "sender_profile": json.loads(row["sender_profile"] or "{}"),
        "parent_share_id": int(row.get("parent_share_id") or 0),
        "has_screenshot": bool(str(row.get("screenshot_path") or "").strip()),
    }
    if replies is not None:
        payload["replies"] = replies
    return payload


SYNC_ENTITY_TYPES = ("sentences", "vocab_items")


def _snapshot_index(snapshot: dict | None, entity_type: str) -> dict[str, dict]:
    data = snapshot or {}
    items = data.get(entity_type) or []
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


def _profile_payload(snapshot: dict | None) -> dict:
    payload = (snapshot or {}).get("profile") or {}
    return dict(payload) if isinstance(payload, dict) else {}


def _stored_profile(db: sqlite3.Connection, user_row: sqlite3.Row) -> dict:
    try:
        profile = json.loads(user_row["profile_json"] or "{}")
    except Exception:
        profile = {}
    _, latest_snapshot = _latest_commit(db, int(user_row["id"]))
    snapshot_profile = _profile_payload(latest_snapshot)
    if not isinstance(profile, dict):
        profile = {}
    merged = dict(snapshot_profile)
    for key, value in profile.items():
        if value not in ("", None):
            merged[key] = value
    return merged


def _recent_series_from_snapshot(snapshot: dict | None, limit: int = 8) -> list[dict]:
    grouped: dict[tuple[str, str, str], list[dict]] = {}
    for item in list((snapshot or {}).get("sentences") or []) + list((snapshot or {}).get("vocab_items") or []):
        if not isinstance(item, dict):
            continue
        playback = item.get("playback") or {}
        if not isinstance(playback, dict):
            playback = {}
        platform = str(playback.get("platform") or "unknown")
        series_name = str(playback.get("series_name") or playback.get("title") or "unknown")
        episode_name = str(playback.get("episode_name") or playback.get("title") or "unknown")
        grouped.setdefault((platform, series_name, episode_name), []).append(item)

    nodes = []
    for (platform, series_name, episode_name), items in grouped.items():
        items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        nodes.append(
            {
                "platform": platform,
                "source": "mixed",
                "series_name": series_name,
                "episode_name": episode_name,
                "items": items,
            }
        )
    nodes.sort(key=lambda node: max((str(item.get("created_at") or "") for item in node["items"]), default=""), reverse=True)
    return nodes[: max(1, min(int(limit or 8), 24))]


def _activity_from_snapshot(snapshot: dict | None, days: int = 365) -> list[dict]:
    cutoff = datetime.now(timezone.utc).date().toordinal() - max(1, min(int(days or 365), 730)) + 1
    by_day: dict[str, dict] = {}

    def day_key(value: str) -> str:
        text = str(value or "").strip()
        return text[:10] if len(text) >= 10 else ""

    for sentence in (snapshot or {}).get("sentences") or []:
        if not isinstance(sentence, dict):
            continue
        day = day_key(sentence.get("created_at"))
        if not day:
            continue
        try:
            if datetime.fromisoformat(day).date().toordinal() < cutoff:
                continue
        except Exception:
            pass
        item = by_day.setdefault(day, {"day": day, "sentence_count": 0, "word_count": 0})
        item["sentence_count"] += 1

    for vocab_item in (snapshot or {}).get("vocab_items") or []:
        if not isinstance(vocab_item, dict):
            continue
        day = day_key(vocab_item.get("created_at"))
        if not day:
            continue
        try:
            if datetime.fromisoformat(day).date().toordinal() < cutoff:
                continue
        except Exception:
            pass
        item = by_day.setdefault(day, {"day": day, "sentence_count": 0, "word_count": 0})
        item["word_count"] += 1

    return sorted(by_day.values(), key=lambda item: item["day"], reverse=True)[: max(1, min(int(days or 365), 730))]


def _normalize_snapshot(snapshot: dict | None) -> dict:
    data = snapshot or {}
    normalized = {"profile": _profile_payload(data)}
    for entity_type in SYNC_ENTITY_TYPES:
        indexed = _snapshot_index(data, entity_type)
        normalized[entity_type] = [indexed[key] for key in sorted(indexed.keys())]
    return normalized


def _entity_changed(prev: dict, curr: dict) -> bool:
    return json.dumps(prev, ensure_ascii=False, sort_keys=True) != json.dumps(curr, ensure_ascii=False, sort_keys=True)


def diff_snapshots(base_snapshot: dict | None, target_snapshot: dict | None) -> dict:
    result: dict[str, list[dict]] = {"created": [], "updated": [], "deleted": []}
    base_profile = _profile_payload(base_snapshot)
    target_profile = _profile_payload(target_snapshot)
    if _entity_changed(base_profile, target_profile):
        result["updated"].append({"type": "profile", "uuid": "profile", "value": target_profile})
    for entity_type in SYNC_ENTITY_TYPES:
        before = _snapshot_index(base_snapshot, entity_type)
        after = _snapshot_index(target_snapshot, entity_type)
        for uid, item in after.items():
            if uid not in before:
                result["created"].append({"type": entity_type, "uuid": uid, "value": item})
            elif _entity_changed(before[uid], item):
                result["updated"].append({"type": entity_type, "uuid": uid, "value": item})
        for uid in before:
            if uid not in after:
                result["deleted"].append({"type": entity_type, "uuid": uid})
    return result


def _latest_commit(db: sqlite3.Connection, user_id: int) -> tuple[int, dict]:
    row = db.execute(
        """
        SELECT version, snapshot_json
        FROM sync_commit
        WHERE user_id = ?
        ORDER BY version DESC
        LIMIT 1
        """,
        (user_id,),
    ).fetchone()
    if not row:
        return 0, {"profile": {}, "sentences": [], "vocab_items": []}
    return int(row["version"]), json.loads(row["snapshot_json"] or "{}")


def _snapshot_for_version(db: sqlite3.Connection, user_id: int, version: int) -> dict:
    if version <= 0:
        return {"profile": {}, "sentences": [], "vocab_items": []}
    row = db.execute(
        """
        SELECT snapshot_json
        FROM sync_commit
        WHERE user_id = ? AND version = ?
        LIMIT 1
        """,
        (user_id, int(version)),
    ).fetchone()
    if not row:
        return {"profile": {}, "sentences": [], "vocab_items": []}
    return json.loads(row["snapshot_json"] or "{}")


class AuthPayload(BaseModel):
    username: str
    password: str
    invite_code: str = ""


class PartnerPayload(BaseModel):
    partner_username: str = ""


class SyncPayload(BaseModel):
    direction: str = "push_pull"
    base_version: int = 0
    data: dict = Field(default_factory=dict)


class SharePayload(BaseModel):
    recipient_username: str = ""
    sentence: dict = Field(default_factory=dict)
    comment: str = ""
    screenshot_base64: str = ""
    parent_share_id: int = 0


class PartnerRequestPayload(BaseModel):
    partner_username: str = ""


class AdminResetPasswordPayload(BaseModel):
    username: str
    password: str


class AdminInviteCodePayload(BaseModel):
    code: str = ""


app = FastAPI(title="Drama Wordbook Server", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()


def current_user(authorization: str = Header(default="")) -> sqlite3.Row:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="missing bearer token")
    with conn() as db:
        row = db.execute('SELECT * FROM "user" WHERE token_hash = ?', (token_hash(token),)).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="invalid token")
    return row


def require_admin(
    x_admin_token: str = Header(default=""),
    token: str = Query(default=""),
) -> bool:
    provided = (x_admin_token or token or "").strip()
    if not provided or not hmac.compare_digest(provided, ADMIN_TOKEN):
        raise HTTPException(status_code=403, detail="invalid admin token")
    return True


@app.get("/health")
def health():
    return {"status": "ok", "time": utc_now()}


@app.get("/admin/users")
def admin_users(_ok: bool = Depends(require_admin)):
    with conn() as db:
        user_rows = db.execute(
            """
            SELECT id, username, password_hash, salt, token_hash, profile_json,
                   partner_username, created_at, updated_at, last_login_at
            FROM "user"
            ORDER BY id DESC
            """
        ).fetchall()
        request_rows = db.execute(
            """
            SELECT r.id, r.status, r.created_at, r.responded_at,
                   fu.username AS from_username, tu.username AS to_username
            FROM partner_request r
            JOIN "user" fu ON fu.id = r.from_user_id
            JOIN "user" tu ON tu.id = r.to_user_id
            ORDER BY r.id DESC
            LIMIT 100
            """
        ).fetchall()
        commit_rows = db.execute(
            """
            SELECT c.id, c.user_id, c.version, c.created_at, u.username
            FROM sync_commit c
            JOIN "user" u ON u.id = c.user_id
            ORDER BY c.id DESC
            LIMIT 200
            """
        ).fetchall()
    return {
        "users": [dict(row) for row in user_rows],
        "partner_requests": [dict(row) for row in request_rows],
        "sync_commits": [dict(row) for row in commit_rows],
    }


@app.post("/admin/users/reset-password")
def admin_reset_password(payload: AdminResetPasswordPayload, _ok: bool = Depends(require_admin)):
    username = payload.username.strip()
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="username >= 3 required")
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="password >= 8 required")
    salt = secrets.token_hex(16)
    pwd_hash = password_hash(payload.password, salt)
    with conn() as db:
        cur = db.execute(
            'UPDATE "user" SET password_hash = ?, salt = ?, updated_at = ? WHERE username = ?',
            (pwd_hash, salt, utc_now(), username),
        )
    if cur.rowcount <= 0:
        raise HTTPException(status_code=404, detail="user not found")
    return {"ok": True, "username": username}


@app.post("/admin/invite-codes")
def admin_create_invite_code(payload: AdminInviteCodePayload, _ok: bool = Depends(require_admin)):
    code = _normalize_invite_code(payload.code)
    if not code:
        code = _generate_invite_code()
    try:
        with conn() as db:
            db.execute(
                """
                INSERT INTO invite_code (code, created_at, used_by_username, used_at)
                VALUES (?, ?, '', NULL)
                """,
                (code, utc_now()),
            )
    except Exception as exc:
        if _is_unique_violation(exc):
            raise HTTPException(status_code=409, detail="invite code already exists") from exc
        raise
    return {"ok": True, "code": code}


@app.get("/admin", response_class=HTMLResponse)
def admin_page(_ok: bool = Depends(require_admin)):
    with conn() as db:
        user_rows = db.execute(
            """
            SELECT id, username, password_hash, salt, token_hash, profile_json,
                   partner_username, created_at, updated_at, last_login_at
            FROM "user"
            ORDER BY id DESC
            """
        ).fetchall()
        request_rows = db.execute(
            """
            SELECT r.id, r.status, r.created_at, r.responded_at,
                   fu.username AS from_username, tu.username AS to_username
            FROM partner_request r
            JOIN "user" fu ON fu.id = r.from_user_id
            JOIN "user" tu ON tu.id = r.to_user_id
            ORDER BY r.id DESC
            LIMIT 100
            """
        ).fetchall()
        commit_rows = db.execute(
            """
            SELECT c.id, c.user_id, c.version, c.created_at, u.username
            FROM sync_commit c
            JOIN "user" u ON u.id = c.user_id
            ORDER BY c.id DESC
            LIMIT 200
            """
        ).fetchall()
    user_rows_html = "\n".join(
        f"""
        <tr>
          <td>{int(row["id"])}</td>
          <td>{html.escape(str(row["username"] or ""))}</td>
          <td class="mono">{html.escape(str(row["password_hash"] or ""))}</td>
          <td class="mono">{html.escape(str(row["salt"] or ""))}</td>
          <td class="mono">{html.escape(str(row["token_hash"] or ""))}</td>
          <td>{html.escape(str(row["partner_username"] or ""))}</td>
          <td>{html.escape(str(row["last_login_at"] or ""))}</td>
          <td>{html.escape(str(row["updated_at"] or ""))}</td>
          <td><pre>{html.escape(str(row["profile_json"] or "{}"))}</pre></td>
        </tr>
        """.strip()
        for row in user_rows
    )
    request_rows_html = "\n".join(
        f"""
        <tr>
          <td>{int(row["id"])}</td>
          <td>{html.escape(str(row["from_username"] or ""))}</td>
          <td>{html.escape(str(row["to_username"] or ""))}</td>
          <td>{html.escape(str(row["status"] or ""))}</td>
          <td>{html.escape(str(row["created_at"] or ""))}</td>
          <td>{html.escape(str(row["responded_at"] or ""))}</td>
        </tr>
        """.strip()
        for row in request_rows
    )
    commit_rows_html = "\n".join(
        f"""
        <tr>
          <td>{int(row["id"])}</td>
          <td>{html.escape(str(row["username"] or ""))}</td>
          <td>{int(row["version"] or 0)}</td>
          <td>{html.escape(str(row["created_at"] or ""))}</td>
        </tr>
        """.strip()
        for row in commit_rows
    )
    return f"""
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Drama Wordbook 调试管理台</title>
    <style>
      body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 16px; color: #1f2937; }}
      h1, h2 {{ margin: 0 0 8px 0; }}
      h2 {{ margin-top: 24px; }}
      table {{ width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }}
      th, td {{ border: 1px solid #e5e7eb; padding: 6px 8px; vertical-align: top; text-align: left; }}
      th {{ background: #f9fafb; }}
      .mono {{ font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 12px; word-break: break-all; }}
      pre {{ margin: 0; white-space: pre-wrap; font-size: 12px; max-width: 360px; }}
      .hint {{ color: #6b7280; font-size: 13px; }}
      .bar {{ display: flex; gap: 8px; align-items: center; margin: 10px 0 6px 0; }}
      input {{ padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; }}
      button {{ padding: 6px 10px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }}
    </style>
  </head>
  <body>
    <h1>Drama Wordbook 调试管理台</h1>
    <p class="hint">密码以哈希形式存储，无法反查明文；可用下面的重置功能直接改测试账号密码。</p>
    <div class="bar">
      <input id="u" placeholder="用户名" />
      <input id="p" type="password" placeholder="新密码（至少8位）" />
      <button onclick="resetPwd()">重置密码</button>
      <button onclick="location.reload()">刷新</button>
    </div>
    <p id="msg" class="hint"></p>

    <h2>用户</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>用户名</th><th>password_hash</th><th>salt</th><th>token_hash</th>
          <th>搭子</th><th>最近登录</th><th>更新时间</th><th>profile_json</th>
        </tr>
      </thead>
      <tbody>{user_rows_html}</tbody>
    </table>

    <h2>搭子申请（最近100条）</h2>
    <table>
      <thead>
        <tr><th>ID</th><th>发起人</th><th>目标</th><th>状态</th><th>创建时间</th><th>响应时间</th></tr>
      </thead>
      <tbody>{request_rows_html}</tbody>
    </table>

    <h2>同步提交（最近200条）</h2>
    <table>
      <thead>
        <tr><th>ID</th><th>用户</th><th>版本</th><th>创建时间</th></tr>
      </thead>
      <tbody>{commit_rows_html}</tbody>
    </table>

    <script>
      async function resetPwd() {{
        const username = document.getElementById("u").value.trim();
        const password = document.getElementById("p").value;
        const msg = document.getElementById("msg");
        msg.textContent = "提交中...";
        try {{
          const res = await fetch("/admin/users/reset-password" + location.search, {{
            method: "POST",
            headers: {{ "Content-Type": "application/json" }},
            body: JSON.stringify({{ username, password }})
          }});
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || JSON.stringify(data));
          msg.textContent = "重置成功：" + username;
        }} catch (e) {{
          msg.textContent = "重置失败：" + (e && e.message ? e.message : String(e));
        }}
      }}
    </script>
  </body>
</html>
"""


@app.post("/auth/register")
def register(payload: AuthPayload):
    username = payload.username.strip()
    invite_code = _normalize_invite_code(payload.invite_code)
    if len(username) < 3 or len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="username >= 3 and password >= 8 required")
    if not invite_code:
        raise HTTPException(status_code=400, detail="invite code is required")
    salt = secrets.token_hex(16)
    token = secrets.token_urlsafe(32)
    now = utc_now()
    try:
        with conn() as db:
            invite_cur = db.execute(
                """
                UPDATE invite_code
                SET used_by_username = ?, used_at = ?
                WHERE code = ? AND used_at IS NULL
                """,
                (username, now, invite_code),
            )
            if invite_cur.rowcount <= 0:
                raise HTTPException(status_code=400, detail="invite code is invalid or already used")
            db.execute(
                """
                INSERT INTO "user" (username, password_hash, salt, token_hash, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (username, password_hash(payload.password, salt), salt, token_hash(token), now, now),
            )
            db.execute('UPDATE "user" SET last_login_at = ? WHERE username = ?', (now, username))
    except Exception as exc:
        if not _is_unique_violation(exc):
            raise
        raise HTTPException(status_code=409, detail="username already exists") from exc
    return {"access_token": token, "token_type": "bearer"}


@app.post("/auth/login")
def login(payload: AuthPayload):
    with conn() as db:
        row = db.execute('SELECT * FROM "user" WHERE username = ?', (payload.username.strip(),)).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="invalid username or password")
        expected = password_hash(payload.password, row["salt"])
        if not hmac.compare_digest(expected, row["password_hash"]):
            raise HTTPException(status_code=401, detail="invalid username or password")
        token = secrets.token_urlsafe(32)
        db.execute(
            'UPDATE "user" SET token_hash = ?, updated_at = ?, last_login_at = ? WHERE id = ?',
            (token_hash(token), utc_now(), utc_now(), int(row["id"])),
        )
    return {"access_token": token, "token_type": "bearer"}


@app.post("/auth/logout")
def logout(user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        db.execute('UPDATE "user" SET token_hash = NULL, updated_at = ? WHERE id = ?', (utc_now(), int(user["id"])))
    return {"ok": True}


@app.get("/me")
def me(user: sqlite3.Row = Depends(current_user)):
    partner_info = None
    partner_username = str(user["partner_username"] or "").strip()
    with conn() as db:
        profile = _stored_profile(db, user)
        if partner_username:
            partner_row = db.execute(
                'SELECT id, username, profile_json, last_login_at FROM "user" WHERE username = ?',
                (partner_username,),
            ).fetchone()
            if partner_row:
                partner_info = {
                    "username": partner_row["username"],
                    "profile": _stored_profile(db, partner_row),
                    "last_login_at": partner_row["last_login_at"],
                }
    return {
        "username": user["username"],
        "profile": profile,
        "partner_username": partner_username,
        "last_login_at": user["last_login_at"],
        "partner": partner_info,
    }


@app.put("/me/profile")
def update_profile(profile: dict, user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        db.execute(
            'UPDATE "user" SET profile_json = ?, updated_at = ? WHERE id = ?',
            (json.dumps(profile, ensure_ascii=False), utc_now(), int(user["id"])),
        )
    return {"ok": True}


@app.put("/me/partner")
def bind_partner(payload: PartnerPayload, user: sqlite3.Row = Depends(current_user)):
    partner = payload.partner_username.strip()
    with conn() as db:
        if partner:
            exists = db.execute('SELECT id FROM "user" WHERE username = ?', (partner,)).fetchone()
            if not exists:
                raise HTTPException(status_code=404, detail="partner not found")
        db.execute(
            'UPDATE "user" SET partner_username = ?, updated_at = ? WHERE id = ?',
            (partner, utc_now(), int(user["id"])),
        )
    return {"ok": True, "partner_username": partner}


def _has_partner(db: sqlite3.Connection, user_id: int) -> bool:
    row = db.execute('SELECT partner_username FROM "user" WHERE id = ?', (user_id,)).fetchone()
    if not row:
        return False
    return bool(str(row["partner_username"] or "").strip())


@app.post("/partner/requests")
def create_partner_request(payload: PartnerRequestPayload, user: sqlite3.Row = Depends(current_user)):
    target = payload.partner_username.strip()
    if not target:
        raise HTTPException(status_code=400, detail="partner username required")
    if target == user["username"]:
        raise HTTPException(status_code=400, detail="cannot request yourself")
    with conn() as db:
        if _has_partner(db, int(user["id"])):
            raise HTTPException(status_code=400, detail="you already have a partner")
        target_row = db.execute('SELECT id, partner_username FROM "user" WHERE username = ?', (target,)).fetchone()
        if not target_row:
            raise HTTPException(status_code=404, detail="partner not found")
        if str(target_row["partner_username"] or "").strip():
            raise HTTPException(status_code=400, detail="target already has a partner")
        exists = db.execute(
            """
            SELECT id FROM partner_request
            WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'
            LIMIT 1
            """,
            (int(user["id"]), int(target_row["id"])),
        ).fetchone()
        if exists:
            return {"ok": True, "id": int(exists["id"]), "status": "pending"}
        request_id = _insert_and_get_id(
            db,
            """
            INSERT INTO partner_request (from_user_id, to_user_id, status, created_at)
            VALUES (?, ?, 'pending', ?)
            """,
            (int(user["id"]), int(target_row["id"]), utc_now()),
        )
    return {"ok": True, "id": request_id, "status": "pending"}


@app.get("/partner/state")
def partner_state(user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        partner = None
        partner_username = str(user["partner_username"] or "").strip()
        if partner_username:
            partner_row = db.execute(
                'SELECT id, username, profile_json, last_login_at FROM "user" WHERE username = ?',
                (partner_username,),
            ).fetchone()
            if partner_row:
                _, partner_snapshot = _latest_commit(db, int(partner_row["id"]))
                partner = {
                    "username": partner_row["username"],
                    "profile": _stored_profile(db, partner_row),
                    "last_login_at": partner_row["last_login_at"],
                    "recent_series": _recent_series_from_snapshot(partner_snapshot, 8),
                    "activity": _activity_from_snapshot(partner_snapshot, 365),
                }

        inbound_rows = db.execute(
            """
            SELECT r.id, r.created_at, u.username AS from_username, u.profile_json AS from_profile
            FROM partner_request r
            JOIN "user" u ON u.id = r.from_user_id
            WHERE r.to_user_id = ? AND r.status = 'pending'
            ORDER BY r.id DESC
            """,
            (int(user["id"]),),
        ).fetchall()
        outbound_rows = db.execute(
            """
            SELECT r.id, r.created_at, u.username AS to_username
            FROM partner_request r
            JOIN "user" u ON u.id = r.to_user_id
            WHERE r.from_user_id = ? AND r.status = 'pending'
            ORDER BY r.id DESC
            """,
            (int(user["id"]),),
        ).fetchall()
    return {
        "partner": partner,
        "can_send_request": not partner,
        "inbound_requests": [
            {
                "id": int(row["id"]),
                "created_at": row["created_at"],
                "from_username": row["from_username"],
                "from_profile": json.loads(row["from_profile"] or "{}"),
            }
            for row in inbound_rows
        ],
        "outbound_requests": [
            {
                "id": int(row["id"]),
                "created_at": row["created_at"],
                "to_username": row["to_username"],
            }
            for row in outbound_rows
        ],
    }


@app.post("/partner/requests/{request_id}/accept")
def accept_partner_request(request_id: int, user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        req = db.execute(
            """
            SELECT r.id, r.from_user_id, r.to_user_id, r.status, f.username AS from_username
            FROM partner_request r
            JOIN "user" f ON f.id = r.from_user_id
            WHERE r.id = ? AND r.to_user_id = ?
            """,
            (request_id, int(user["id"])),
        ).fetchone()
        if not req or req["status"] != "pending":
            raise HTTPException(status_code=404, detail="request not found")
        if _has_partner(db, int(user["id"])):
            raise HTTPException(status_code=400, detail="you already have a partner")
        if _has_partner(db, int(req["from_user_id"])):
            raise HTTPException(status_code=400, detail="request sender already has a partner")

        now = utc_now()
        db.execute(
            'UPDATE "user" SET partner_username = ?, updated_at = ? WHERE id = ?',
            (req["from_username"], now, int(user["id"])),
        )
        db.execute(
            'UPDATE "user" SET partner_username = ?, updated_at = ? WHERE id = ?',
            (user["username"], now, int(req["from_user_id"])),
        )
        db.execute(
            "UPDATE partner_request SET status = 'accepted', responded_at = ? WHERE id = ?",
            (now, request_id),
        )
        db.execute(
            """
            UPDATE partner_request
            SET status = 'rejected', responded_at = ?
            WHERE status = 'pending'
              AND (
                from_user_id IN (?, ?) OR to_user_id IN (?, ?)
              )
            """,
            (now, int(user["id"]), int(req["from_user_id"]), int(user["id"]), int(req["from_user_id"])),
        )
    return {"ok": True}


@app.post("/shares")
def share_sentence(payload: SharePayload, user: sqlite3.Row = Depends(current_user)):
    recipient_name = payload.recipient_username.strip() or str(user["partner_username"] or "").strip()
    if not recipient_name:
        raise HTTPException(status_code=400, detail="partner is not configured")
    with conn() as db:
        recipient = db.execute('SELECT id, username FROM "user" WHERE username = ?', (recipient_name,)).fetchone()
        if not recipient:
            raise HTTPException(status_code=404, detail="partner not found")
        share_id = _insert_and_get_id(
            db,
            """
            INSERT INTO share_message (sender_id, recipient_id, sentence_json, comment, screenshot_path, parent_share_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(user["id"]),
                int(recipient["id"]),
                json.dumps(payload.sentence, ensure_ascii=False),
                payload.comment.strip(),
                _save_share_screenshot(payload.screenshot_base64),
                max(0, int(payload.parent_share_id or 0)) or None,
                utc_now(),
            ),
        )
    return {"ok": True, "id": share_id}


@app.get("/shares/unread")
def unread_shares(user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        rows = [
            dict(row)
            for row in db.execute(
            """
            SELECT m.id, m.sentence_json, m.comment, m.created_at, m.parent_share_id, m.screenshot_path,
                   u.username AS sender_username, u.profile_json AS sender_profile
            FROM share_message m
            JOIN "user" u ON u.id = m.sender_id
            WHERE m.recipient_id = ? AND m.read_at IS NULL
            ORDER BY m.id DESC
            LIMIT 50
            """,
            (int(user["id"]),),
        ).fetchall()
        ]
        share_ids = [int(row["id"]) for row in rows]
        replies_by_parent: dict[int, list[dict]] = {}
        if share_ids:
            replies = [
                dict(row)
                for row in db.execute(
                    """
                    SELECT m.id, m.parent_share_id, m.sentence_json, m.comment, m.created_at, m.screenshot_path,
                           u.username AS sender_username, u.profile_json AS sender_profile
                    FROM share_message m
                    JOIN "user" u ON u.id = m.sender_id
                    WHERE m.parent_share_id IS NOT NULL
                      AND m.parent_share_id IN ({placeholders})
                      AND (m.sender_id = ? OR m.recipient_id = ?)
                    ORDER BY m.id ASC
                    """.format(
                        placeholders=",".join("?" for _ in share_ids)
                    ),
                    (*share_ids, int(user["id"]), int(user["id"])),
                ).fetchall()
            ]
            for row in replies:
                parent_id = int(row["parent_share_id"] or 0)
                if parent_id <= 0:
                    continue
                replies_by_parent.setdefault(parent_id, []).append(_share_to_response(row))
    return {
        "items": [
            _share_to_response(row, replies_by_parent.get(int(row["id"]), []))
            for row in rows
        ]
    }


@app.get("/shares/recent-comments")
def recent_share_comments(user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        rows = db.execute(
            """
            SELECT id, comment, created_at
            FROM share_message
            WHERE sender_id = ? AND TRIM(comment) != ''
            ORDER BY id DESC
            LIMIT 40
            """,
            (int(user["id"]),),
        ).fetchall()
    items = []
    seen: set[str] = set()
    for row in rows:
        comment = str(row["comment"] or "").strip()
        if not comment or comment in seen:
            continue
        seen.add(comment)
        items.append({"id": int(row["id"]), "comment": comment, "created_at": row["created_at"]})
    return {"items": items}


@app.post("/shares/{share_id}/reply")
def reply_share(share_id: int, payload: SharePayload, user: sqlite3.Row = Depends(current_user)):
    comment = str(payload.comment or "").strip()
    if not comment:
        raise HTTPException(status_code=400, detail="reply comment required")
    with conn() as db:
        parent = db.execute(
            """
            SELECT id, sender_id, recipient_id, sentence_json
            FROM share_message
            WHERE id = ?
            LIMIT 1
            """,
            (int(share_id),),
        ).fetchone()
        if not parent:
            raise HTTPException(status_code=404, detail="share not found")
        me = int(user["id"])
        sender_id = int(parent["sender_id"])
        recipient_id = int(parent["recipient_id"])
        if me not in (sender_id, recipient_id):
            raise HTTPException(status_code=403, detail="forbidden")
        target_user_id = recipient_id if me == sender_id else sender_id
        reply_id = _insert_and_get_id(
            db,
            """
            INSERT INTO share_message (sender_id, recipient_id, sentence_json, comment, screenshot_path, parent_share_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                me,
                target_user_id,
                parent["sentence_json"] or "{}",
                comment,
                "",
                int(share_id),
                utc_now(),
            ),
        )
    return {"ok": True, "id": reply_id}


@app.get("/shares/{share_id}/screenshot")
def share_screenshot(share_id: int, user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        row = db.execute(
            """
            SELECT sender_id, recipient_id, screenshot_path
            FROM share_message
            WHERE id = ?
            LIMIT 1
            """,
            (int(share_id),),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="share not found")
    me = int(user["id"])
    if me not in (int(row["sender_id"]), int(row["recipient_id"])):
        raise HTTPException(status_code=403, detail="forbidden")
    file_name = str(row["screenshot_path"] or "").strip()
    if not file_name:
        raise HTTPException(status_code=404, detail="screenshot not found")
    path = (SHARE_SCREENSHOT_DIR / file_name).resolve()
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="screenshot not found")
    return FileResponse(path)


@app.post("/shares/{share_id}/read")
def mark_share_read(share_id: int, user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        cur = db.execute(
            "UPDATE share_message SET read_at = ? WHERE id = ? AND recipient_id = ?",
            (utc_now(), share_id, int(user["id"])),
        )
    if cur.rowcount <= 0:
        raise HTTPException(status_code=404, detail="share not found")
    return {"ok": True}


@app.post("/sync/push")
def sync_push(payload: SyncPayload, user: sqlite3.Row = Depends(current_user)):
    now = utc_now()
    with conn() as db:
        user_id = int(user["id"])
        latest_version, latest_snapshot = _latest_commit(db, user_id)
        base_version = max(0, int(payload.base_version or 0))
        if base_version != latest_version:
            base_snapshot = _snapshot_for_version(db, user_id, base_version)
            return {
                "ok": False,
                "state": "needs_pull",
                "message": "Remote has newer commits. Pull updates before pushing local changes.",
                "latest_version": latest_version,
                "remote_changes": diff_snapshots(base_snapshot, latest_snapshot),
            }
        next_snapshot = _normalize_snapshot(payload.data)
        next_version = latest_version + 1
        db.execute(
            """
            INSERT INTO sync_commit (user_id, version, snapshot_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user_id, next_version, json.dumps(next_snapshot, ensure_ascii=False), now),
        )
        db.execute(
            "INSERT INTO sync_snapshot (user_id, payload_json, created_at) VALUES (?, ?, ?)",
            (user_id, json.dumps(next_snapshot, ensure_ascii=False), now),
        )
        db.execute(
            'UPDATE "user" SET updated_at = ?, profile_json = ? WHERE id = ?',
            (now, json.dumps(_profile_payload(next_snapshot), ensure_ascii=False), user_id),
        )
        partner_payload = None
        if user["partner_username"]:
            partner = db.execute('SELECT id FROM "user" WHERE username = ?', (user["partner_username"],)).fetchone()
            if partner:
                p_version, p_snapshot = _latest_commit(db, int(partner["id"]))
                if p_version > 0:
                    partner_payload = {"data": p_snapshot, "version": p_version}
    return {"ok": True, "synced_at": now, "version": next_version, "partner": partner_payload}


@app.get("/sync/state")
def sync_state(user: sqlite3.Row = Depends(current_user)):
    with conn() as db:
        latest_version, _ = _latest_commit(db, int(user["id"]))
    return {"ok": True, "latest_version": latest_version}


@app.get("/sync/changes")
def sync_changes(since_version: int = 0, user: sqlite3.Row = Depends(current_user)):
    base_version = max(0, int(since_version or 0))
    with conn() as db:
        latest_version, latest_snapshot = _latest_commit(db, int(user["id"]))
        if base_version > latest_version:
            base_version = latest_version
        base_snapshot = _snapshot_for_version(db, int(user["id"]), base_version)
    return {
        "ok": True,
        "base_version": base_version,
        "latest_version": latest_version,
        "changes": diff_snapshots(base_snapshot, latest_snapshot),
        "snapshot": latest_snapshot,
    }

"""
百词斩式复习：按词头 vocab_head、三种题型会话，与「三日记住」精通状态。
"""

from __future__ import annotations

import json
import random
import re
import sqlite3
import unicodedata
from datetime import timezone
from datetime import datetime as dt
from typing import Literal
from uuid import uuid4

from app.services.dictionary_service import ensure_meaning_chinese, lookup_dictionary
from app.services.tokenizer_service import tokenize_ja
from app.services.vocab_service import _get_conn, get_head_items

Kanji_Re = re.compile(r"[\u3400-\u9fff\uF900-\uFAFF]")

Mode = Literal["mc", "reading", "sentence"]


def init_review_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS review_head_state (
            head_id INTEGER PRIMARY KEY,
            mastered INTEGER NOT NULL DEFAULT 0,
            mastered_at TEXT,
            correct_calendar_days_json TEXT NOT NULL DEFAULT '[]',
            FOREIGN KEY(head_id) REFERENCES vocab_head(id)
        );

        CREATE TABLE IF NOT EXISTS review_session (
            id TEXT PRIMARY KEY,
            calendar_day TEXT NOT NULL,
            question_limit INTEGER NOT NULL,
            cursor_index INTEGER NOT NULL DEFAULT 0,
            queue_json TEXT NOT NULL DEFAULT '[]',
            completed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_review_session_cal ON review_session(calendar_day, completed);
        """
    )
    # typo fix migration
    rows = conn.execute("PRAGMA table_info(review_session)").fetchall()
    col_names = {r["name"] for r in rows}
    if "queue_json" not in col_names:
        conn.execute("ALTER TABLE review_session ADD COLUMN queue_json TEXT NOT NULL DEFAULT '[]'")
    conn.commit()


def _utc_now_iso() -> str:
    return dt.now(timezone.utc).isoformat()


def sanitize_question_for_client(q: dict | None) -> dict | None:
    """読み取り題：首次作答前不向客户端下发标准读音（仍可 TTS prompt_surface）。"""
    if not q:
        return None
    out = dict(q)
    if out.get("mode") == "reading" and not out.get("mistake_seen"):
        out.pop("expected_normalized", None)
    return out


def _has_kanji(text: str) -> bool:
    return bool(text and Kanji_Re.search(text))


def _normalize_reading(answer: str) -> str:
    s = unicodedata.normalize("NFKC", (answer or "").strip())
    s = "".join(ch for ch in s if not ch.isspace())
    out: list[str] = []
    for ch in s:
        o = ord(ch)
        if 0x30A1 <= o <= 0x30FE or o == 0x30FD or o == 0x30FC:
            if 0x30A1 <= o <= 0x30F6:
                out.append(chr(o - 0x60))
            elif o == 0x30F4:
                out.extend(["う", "\u3099"])
            else:
                out.append(ch)
        else:
            out.append(ch)
    return "".join(out).lower()


def _expected_reading_script(reading: str) -> Literal["hiragana", "katakana", "mixed"]:
    r = "".join(reading.split())
    if not r:
        return "mixed"
    h = sum(1 for ch in r if "\u3040" <= ch <= "\u309f")
    k = sum(1 for ch in r if "\u30a0" <= ch <= "\u30ff")
    if k >= h * 1.5 and k >= 2:
        return "katakana"
    if h >= k * 1.5 and h >= 2:
        return "hiragana"
    return "mixed"


def _sentence_pieces(example_ja: str) -> list[str]:
    toks = tokenize_ja((example_ja or "").strip(), include_stop=True)
    parts = [t.get("surface", "").strip() for t in (toks or []) if str(t.get("surface", "") or "").strip()]
    return parts


def _ensure_review_state_row(conn: sqlite3.Connection, head_id: int) -> tuple[bool, list[str]]:
    row = conn.execute(
        "SELECT mastered, correct_calendar_days_json FROM review_head_state WHERE head_id = ?",
        (head_id,),
    ).fetchone()
    if not row:
        conn.execute(
            """
            INSERT INTO review_head_state (head_id, mastered, mastered_at, correct_calendar_days_json)
            VALUES (?, 0, NULL, ?)
            """,
            (head_id, json.dumps([], ensure_ascii=False)),
        )
        conn.commit()
        return False, []
    mastered = bool(int(row["mastered"] or 0))
    days = json.loads(row["correct_calendar_days_json"] or "[]")
    if not isinstance(days, list):
        days = []
    return mastered, days


def _eligible_head_ids(conn: sqlite3.Connection) -> list[int]:
    rows = conn.execute(
        """
        SELECT DISTINCT h.id AS hid
        FROM vocab_head h
        INNER JOIN vocab_item i ON i.head_id = h.id
        LEFT JOIN review_head_state r ON r.head_id = h.id
        WHERE IFNULL(r.mastered, 0) = 0
        ORDER BY h.updated_at DESC
        """
    ).fetchall()
    return [int(r["hid"]) for r in rows]


def _zh_meanings_for_ref(ref: dict) -> list[str]:
    """复习选义：释义统一为中文（词典 + 逐条翻译）。"""
    out: list[str] = []
    df = str((ref or {}).get("dictionary_form") or (ref or {}).get("surface") or "").strip()
    if df:
        try:
            dj = lookup_dictionary(df)
            for m in dj.get("meanings") or []:
                t = ensure_meaning_chinese(str(m).strip())
                if t and t not in out:
                    out.append(t)
        except Exception:
            pass
    for m in (ref or {}).get("meanings") or []:
        t = ensure_meaning_chinese(str(m).strip())
        if t and t not in out:
            out.append(t)
    return out[:10]


def _distraction_meanings(conn: sqlite3.Connection, exclude_head: int, k: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT meanings_json FROM vocab_item WHERE head_id != ? ORDER BY RANDOM() LIMIT ?
        """,
        (exclude_head, max(k * 4, 12)),
    ).fetchall()
    pool: list[str] = []
    for row in rows:
        try:
            arr = json.loads(row["meanings_json"] or "[]")
        except Exception:
            arr = []
        for m in arr or []:
            t = ensure_meaning_chinese(str(m).strip())
            if t and t not in pool:
                pool.append(t)
        if len(pool) >= k * 3:
            break
    random.shuffle(pool)
    return pool[:k]


def _capabilities_for_head(conn: sqlite3.Connection, head_id: int) -> dict:
    items = get_head_items(head_id)
    ref: dict | None = None
    meanings: list[str] = []
    for it in items or []:
        zm = _zh_meanings_for_ref(it)
        if zm:
            ref = it
            meanings = zm
            break
    if not ref and items:
        ref = items[0]
        meanings = _zh_meanings_for_ref(ref)
    surf = str((ref or {}).get("surface", "") or "")
    df = str((ref or {}).get("dictionary_form", "") or "")
    rd = str((ref or {}).get("reading", "") or "")
    can_read = (_has_kanji(surf) or _has_kanji(df)) and bool(rd.strip())
    rows = conn.execute(
        """
        SELECT s.id AS sid, s.example_ja
        FROM vocab_item i
        INNER JOIN sentence s ON s.id = i.sentence_id
        WHERE i.head_id = ? AND TRIM(IFNULL(s.example_ja, '')) != ''
        LIMIT 24
        """,
        (head_id,),
    ).fetchall()
    sentence_choice: tuple[int, str] | None = None
    random.shuffle(rows)
    for row in rows or []:
        ja = row["example_ja"] or ""
        parts = _sentence_pieces(ja)
        if len(parts) >= 3:
            sentence_choice = (int(row["sid"]), ja)
            break
    return {
        "head_id": head_id,
        "ref": ref or {},
        "meanings": meanings,
        "can_mc": len(meanings) > 0,
        "can_read": can_read,
        "sentence": sentence_choice,
    }


def _build_question_payload(conn: sqlite3.Connection, *, head_id: int, mode: Mode | None = None, avoid: Mode | None = None) -> dict | None:
    cap = _capabilities_for_head(conn, head_id)
    cand_modes: list[Mode] = []
    if cap["can_mc"]:
        cand_modes.append("mc")
    if cap["can_read"]:
        cand_modes.append("reading")
    if cap.get("sentence"):
        cand_modes.append("sentence")
    if avoid and avoid in cand_modes and len(cand_modes) > 1:
        cand_modes = [m for m in cand_modes if m != avoid]
    if not cand_modes:
        return None
    use = mode if mode in cand_modes else random.choice(cand_modes)
    ref = cap["ref"] or {}
    qid = str(uuid4())
    if use == "mc":
        corr = ""
        meanings = cap["meanings"] or []
        if meanings:
            corr = random.choice(meanings)
        distractions = _distraction_meanings(conn, head_id, 8)
        pool = [c for c in distractions if c and c != corr][:3]
        while len(pool) < 3:
            base = (meanings[0] if meanings else "干扰项") + "·" + str(random.randint(1, 999))
            if base != corr and base not in pool:
                pool.append(base)
        opts = pool[:3] + [corr]
        random.shuffle(opts)
        correct_idx = opts.index(corr)
        return {
            "id": qid,
            "head_id": head_id,
            "mode": "mc",
            "prompt_surface": ref.get("surface", ""),
            "dictionary_form": ref.get("dictionary_form", ""),
            "choices": opts,
            "correct_index": correct_idx,
        }
    if use == "reading":
        prompt = str(ref.get("surface") or ref.get("dictionary_form") or "")
        reading = str(ref.get("reading") or "")
        return {
            "id": qid,
            "head_id": head_id,
            "mode": "reading",
            "prompt_surface": prompt,
            "expected_normalized": _normalize_reading(reading),
            "reading_script_hint": _expected_reading_script(reading),
            "tts_text": prompt or reading,
            "mistake_seen": False,
        }
    sentence_id, example_ja = cap["sentence"]
    zh_row = conn.execute(
        "SELECT example_zh FROM sentence WHERE id = ?", (sentence_id,)
    ).fetchone()
    example_zh = zh_row["example_zh"] if zh_row else ""
    models = _sentence_piece_models(example_ja)
    shuffled = list(models)
    random.shuffle(shuffled)
    corr_order = sorted(models, key=lambda x: float(x["_ord"]))
    clean = [{"id": p["id"], "surface": p["surface"]} for p in models]
    return {
        "id": qid,
        "head_id": head_id,
        "mode": "sentence",
        "sentence_id": sentence_id,
        "example_ja_plain": example_ja,
        "example_zh": example_zh,
        "shuffled_piece_ids": [p["id"] for p in shuffled],
        "pieces": clean,
        "correct_order_ids": [p["id"] for p in corr_order],
        "correct_surface_join": "".join(str(p["surface"]) for p in corr_order),
    }


def _sentence_piece_models(example_ja: str) -> list[dict]:
    surfaces = _sentence_pieces(example_ja)
    order: list[dict] = []
    for i, s in enumerate(surfaces):
        order.append({"id": f"p{i}", "surface": s, "_ord": i})
    return order


def _repair_sentence_question(q: dict) -> dict:
    """补齐旧队列里句段结构。"""
    ja = q.get("example_ja_plain") or ""
    mod = dict(q)
    if "pieces" in mod and mod["pieces"]:
        return mod
    if ja:
        models = _sentence_piece_models(ja)
        corr = sorted(models, key=lambda x: float(x["_ord"]))
        mod["pieces"] = [{"id": p["id"], "surface": p["surface"]} for p in models]
        mod["correct_order_ids"] = [p["id"] for p in corr]
        mod["correct_surface_join"] = "".join(str(p["surface"]) for p in corr)
    return mod


def _sentence_order_matches(order_ids: list, question: dict) -> bool:
    corr = question.get("correct_order_ids") or []
    if not isinstance(order_ids, list) or len(order_ids) != len(corr):
        return False
    if tuple(order_ids) == tuple(corr):
        return True
    pieces = question.get("pieces") or []
    by_id = {str(p.get("id")): str(p.get("surface") or "") for p in pieces if isinstance(p, dict)}
    submitted = [by_id.get(str(pid), "") for pid in order_ids]
    expected = [by_id.get(str(pid), "") for pid in corr]
    return submitted == expected and all(submitted)


def _record_daily_correct(conn: sqlite3.Connection, head_id: int, calendar_day: str) -> dict:
    mastered, days = _ensure_review_state_row(conn, head_id)
    if mastered:
        return {"mastered": True, "distinct_days": len(set(days)), "updated": False}

    days_list = sorted(set([*(days if isinstance(days, list) else []), calendar_day]))
    mastered_now = len(days_list) >= 3
    now_iso = _utc_now_iso()

    conn.execute(
        """
        UPDATE review_head_state
        SET correct_calendar_days_json = ?,
            mastered = CASE WHEN ? >= 3 THEN 1 ELSE mastered END,
            mastered_at = CASE WHEN ? >= 3 THEN COALESCE(mastered_at, ?) ELSE mastered_at END
        WHERE head_id = ?
        """
        ,
        (
            json.dumps(days_list, ensure_ascii=False),
            len(days_list),
            len(days_list),
            now_iso,
            head_id,
        ),
    )
    conn.commit()

    row = conn.execute(
        "SELECT mastered, correct_calendar_days_json FROM review_head_state WHERE head_id = ?",
        (head_id,),
    ).fetchone()
    d2 = json.loads(row["correct_calendar_days_json"] or "[]") if row else days_list
    if not isinstance(d2, list):
        d2 = []
    return {
        "mastered": bool(int(row["mastered"])) if row else mastered_now,
        "distinct_days": len(set(str(x) for x in d2)),
        "updated": True,
    }


def start_or_resume_session(conn: sqlite3.Connection, calendar_day: str, question_limit: int) -> dict:
    conn.execute(
        "UPDATE review_session SET completed = 1 WHERE calendar_day != ? AND completed = 0",
        (calendar_day,),
    )
    active = conn.execute(
        """
        SELECT * FROM review_session WHERE calendar_day = ? AND completed = 0 ORDER BY updated_at DESC LIMIT 1
        """,
        (calendar_day,),
    ).fetchone()
    lim = max(5, min(int(question_limit or 20), 200))
    if active:
        qz = json.loads(active["queue_json"] or "[]")
        cid = int(active["cursor_index"] or 0)
        sess_id = active["id"]
        conn.execute(
            "UPDATE review_session SET updated_at = ? WHERE id = ?",
            (_utc_now_iso(), sess_id),
        )
        conn.commit()
        raw_q = qz[cid] if cid < len(qz) else None
        current = sanitize_question_for_client(raw_q) if isinstance(raw_q, dict) else None
        return {
            "session_id": sess_id,
            "resumed": True,
            "calendar_day": calendar_day,
            "cursor": cid,
            "total": len(qz),
            "current": current,
            "completed": cid >= len(qz),
        }

    heads = _eligible_head_ids(conn)
    if not heads:
        return {
            "session_id": "",
            "resumed": False,
            "calendar_day": calendar_day,
            "cursor": 0,
            "total": 0,
            "current": None,
            "completed": True,
            "empty_reason": "no_eligible_heads",
        }
    random.shuffle(heads)
    pick = heads[: min(len(heads), lim)]
    queue: list[dict] = []
    for hid in pick:
        q = _build_question_payload(conn, head_id=hid)
        if q:
            queue.append(q)
    if not queue:
        return {
            "session_id": "",
            "resumed": False,
            "calendar_day": calendar_day,
            "cursor": 0,
            "total": 0,
            "current": None,
            "completed": True,
            "empty_reason": "cannot_build_questions",
        }
    sess_id = str(uuid4())
    conn.execute(
        """
        INSERT INTO review_session (
            id, calendar_day, question_limit, cursor_index, queue_json, completed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        """,
        (
            sess_id,
            calendar_day,
            lim,
            0,
            json.dumps(queue, ensure_ascii=False),
            _utc_now_iso(),
            _utc_now_iso(),
        ),
    )
    conn.commit()
    raw_q = queue[0] if queue else None
    current = sanitize_question_for_client(raw_q) if isinstance(raw_q, dict) else None
    return {
        "session_id": sess_id,
        "resumed": False,
        "calendar_day": calendar_day,
        "cursor": 0,
        "total": len(queue),
        "current": current,
        "completed": False,
    }


def current_session(conn: sqlite3.Connection, calendar_day: str) -> dict:
    active = conn.execute(
        """
        SELECT * FROM review_session WHERE calendar_day = ? AND completed = 0 ORDER BY updated_at DESC LIMIT 1
        """,
        (calendar_day,),
    ).fetchone()
    if not active:
        return {
            "session_id": "",
            "resumed": False,
            "calendar_day": calendar_day,
            "cursor": 0,
            "total": 0,
            "current": None,
            "completed": True,
            "empty_reason": "no_active_session",
        }
    queue = json.loads(active["queue_json"] or "[]")
    cursor = int(active["cursor_index"] or 0)
    current = sanitize_question_for_client(queue[cursor]) if cursor < len(queue) and isinstance(queue[cursor], dict) else None
    return {
        "session_id": active["id"],
        "resumed": True,
        "calendar_day": calendar_day,
        "cursor": cursor,
        "total": len(queue),
        "current": current,
        "completed": cursor >= len(queue),
    }


def _load_session(conn: sqlite3.Connection, session_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM review_session WHERE id = ?", (session_id,)).fetchone()


def _save_queue(conn: sqlite3.Connection, session_id: str, cursor: int, queue: list) -> None:
    conn.execute(
        "UPDATE review_session SET cursor_index = ?, queue_json = ?, updated_at = ? WHERE id = ?",
        (cursor, json.dumps(queue, ensure_ascii=False), _utc_now_iso(), session_id),
    )
    conn.commit()


def abort_session(conn: sqlite3.Connection, *, session_id: str, calendar_day: str) -> dict:
    row = _load_session(conn, session_id)
    if not row:
        raise ValueError("session_not_found")
    if str(row["calendar_day"]) != calendar_day:
        raise ValueError("calendar_day_mismatch")
    queue = json.loads(row["queue_json"] or "[]")
    cursor = int(row["cursor_index"] or 0)
    conn.execute(
        "UPDATE review_session SET completed = 1, updated_at = ? WHERE id = ?",
        (_utc_now_iso(), session_id),
    )
    conn.commit()
    return {
        "done": True,
        "correct": False,
        "aborted": True,
        "current": None,
        "hint_reading_after_wrong": False,
        "reading_stage": "aborted",
        "head_state": {},
        "advanced": True,
        "remaining_before_abort": max(0, len(queue) - cursor),
    }


def evaluate_answer(conn: sqlite3.Connection, *, session_id: str, calendar_day: str, payload: dict) -> dict:
    row = _load_session(conn, session_id)
    if not row or int(row["completed"]):
        raise ValueError("session_not_found_or_done")
    if str(row["calendar_day"]) != calendar_day:
        raise ValueError("calendar_day_mismatch")
    cursor = int(row["cursor_index"] or 0)
    queue: list = json.loads(row["queue_json"] or "[]")
    if cursor >= len(queue):
        conn.execute(
            "UPDATE review_session SET completed = 1, updated_at = ? WHERE id = ?",
            (_utc_now_iso(), session_id),
        )
        conn.commit()
        return {"done": True, "current": None, "correct": False, "head_state": {}}

    item = queue[cursor]
    mode = item.get("mode")
    if mode == "sentence":
        item = _repair_sentence_question(item)
        queue[cursor] = item
    hid = int(item["head_id"])
    mastery_info: dict[str, object] = {}

    if payload.get("skip"):
        skipped = queue.pop(cursor)
        if cursor >= len(queue):
            conn.execute(
                "UPDATE review_session SET cursor_index = ?, queue_json = ?, completed = 1, updated_at = ? WHERE id = ?",
                (cursor, json.dumps(queue, ensure_ascii=False), _utc_now_iso(), session_id),
            )
            conn.commit()
            nxt = None
            done = True
        else:
            _save_queue(conn, session_id, cursor, queue)
            nxt = queue[cursor]
            done = False
        return {
            "done": done,
            "correct": False,
            "skipped": True,
            "skipped_question_id": skipped.get("id") if isinstance(skipped, dict) else "",
            "current": sanitize_question_for_client(nxt),
            "hint_reading_after_wrong": False,
            "reading_stage": "skipped",
            "head_state": {},
            "advanced": True,
        }

    if mode == "mc":
        idx = payload.get("choice_index")
        ok = isinstance(idx, int) and idx == item.get("correct_index")
        if ok:
            mastery_info = _record_daily_correct(conn, hid, calendar_day)
            cursor += 1
            if cursor >= len(queue):
                conn.execute(
                    "UPDATE review_session SET cursor_index = ?, queue_json = ?, completed = 1, updated_at = ? WHERE id = ?",
                    (cursor, json.dumps(queue, ensure_ascii=False), _utc_now_iso(), session_id),
                )
                conn.commit()
                nxt = None
            else:
                _save_queue(conn, session_id, cursor, queue)
                nxt = queue[cursor]
            return {
                "done": cursor >= len(queue),
                "correct": True,
                "current": sanitize_question_for_client(nxt),
                "hint_reading_after_wrong": False,
                "reading_stage": "",
                "head_state": mastery_info,
            }

        rq = _build_question_payload(conn, head_id=hid, avoid="mc")
        if rq:
            rq["replay_of"] = hid
            queue.append(rq)
        cursor += 1
        _save_queue(conn, session_id, cursor, queue)
        nxt = queue[cursor] if cursor < len(queue) else None
        done = cursor >= len(queue)
        return {
            "done": done,
            "correct": False,
            "current": sanitize_question_for_client(nxt),
            "hint_reading_after_wrong": False,
            "reading_stage": "",
            "head_state": {},
            "advanced": True,
        }

    if mode == "reading":
        guessed = payload.get("text", "")
        ok = _normalize_reading(str(guessed)) == item.get("expected_normalized")
        if ok:
            mastery_info = _record_daily_correct(conn, hid, calendar_day)
            cursor += 1
            if cursor >= len(queue):
                conn.execute(
                    "UPDATE review_session SET cursor_index = ?, queue_json = ?, completed = 1, updated_at = ? WHERE id = ?",
                    (cursor, json.dumps(queue, ensure_ascii=False), _utc_now_iso(), session_id),
                )
                conn.commit()
                nxt = None
                done = True
            else:
                _save_queue(conn, session_id, cursor, queue)
                nxt = queue[cursor]
                done = False
            return {
                "done": done,
                "correct": True,
                "current": sanitize_question_for_client(nxt),
                "hint_reading_after_wrong": False,
                "reading_stage": "ok",
                "head_state": mastery_info,
            }

        mistake_before = bool(item.get("mistake_seen"))
        if not mistake_before:
            item["mistake_seen"] = True
            queue[cursor] = item
            conn.execute(
                "UPDATE review_session SET queue_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(queue, ensure_ascii=False), _utc_now_iso(), session_id),
            )
            conn.commit()
            return {
                "done": False,
                "correct": False,
                "current": sanitize_question_for_client(queue[cursor]),
                "hint_reading_after_wrong": True,
                "reading_stage": "first_wrong_hint",
                "head_state": {},
            }

        rq = _build_question_payload(conn, head_id=hid, avoid="reading")
        if rq:
            rq["replay_of"] = hid
            queue.append(rq)
        item["mistake_seen"] = False
        cursor += 1
        _save_queue(conn, session_id, cursor, queue)
        nxt = queue[cursor] if cursor < len(queue) else None
        done = cursor >= len(queue)
        return {
            "done": done,
            "correct": False,
            "current": sanitize_question_for_client(nxt),
            "hint_reading_after_wrong": False,
            "reading_stage": "skipped_after_repeat",
            "head_state": {},
        }

    if mode == "sentence":
        item = _repair_sentence_question(item)
        queue[cursor] = item
        order = payload.get("order_piece_ids") or []
        ok = _sentence_order_matches(order, item)
        if ok:
            mastery_info = _record_daily_correct(conn, hid, calendar_day)
            cursor += 1
            if cursor >= len(queue):
                conn.execute(
                    "UPDATE review_session SET cursor_index = ?, queue_json = ?, completed = 1, updated_at = ? WHERE id = ?",
                    (cursor, json.dumps(queue, ensure_ascii=False), _utc_now_iso(), session_id),
                )
                conn.commit()
                nxt = None
                done = True
            else:
                _save_queue(conn, session_id, cursor, queue)
                nxt = queue[cursor]
                done = False
            return {
                "done": done,
                "correct": True,
                "current": sanitize_question_for_client(nxt),
                "hint_reading_after_wrong": False,
                "reading_stage": "",
                "head_state": mastery_info,
            }

        rq = _build_question_payload(conn, head_id=hid, avoid="sentence")
        if rq:
            rq["replay_of"] = hid
            queue.append(rq)
        cursor += 1
        _save_queue(conn, session_id, cursor, queue)
        nxt = queue[cursor] if cursor < len(queue) else None
        done = cursor >= len(queue)
        return {
            "done": done,
            "correct": False,
            "current": sanitize_question_for_client(nxt),
            "hint_reading_after_wrong": False,
            "reading_stage": "",
            "head_state": {},
        }

    raise ValueError("unknown_mode")


def review_snapshot() -> dict:
    conn = _get_conn()
    try:
        heads = len(_eligible_head_ids(conn))
        rows = conn.execute(
            """
            SELECT COUNT(*) AS mastered FROM review_head_state WHERE mastered = 1
            """
        ).fetchone()
        mast = int(rows["mastered"] or 0)
        return {"eligible_heads": heads, "mastered_heads": mast}
    finally:
        conn.close()

from __future__ import annotations

import csv
import re
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "jlpt" / "all.csv"
JLPT_RE = re.compile(r"JLPT_(?:N)?([1-5])")
READING_NOTE_RE = re.compile(r"\s*[（(].*?[）)]\s*")


def _clean_key(value: str) -> str:
    return (value or "").strip().replace("～", "")


def _clean_reading(value: str) -> str:
    return READING_NOTE_RE.sub("", (value or "").strip())


def _pick_level(current: str, candidate: str) -> str:
    if not current:
        return candidate
    if not candidate:
        return current
    return candidate if int(candidate[1:]) > int(current[1:]) else current


def _pick_entry(current: dict | None, candidate: dict) -> dict:
    if not current:
        return candidate
    return candidate if int(candidate["level"][1:]) > int(current["level"][1:]) else current


def _pick_level_from_tags(tags: str) -> str:
    level = ""
    for match in JLPT_RE.finditer(tags or ""):
        level = _pick_level(level, f"N{match.group(1)}")
    return level


@lru_cache(maxsize=1)
def get_jlpt_index() -> dict[str, dict]:
    index: dict[str, dict] = {}
    if not DATA_PATH.exists():
        return index

    with DATA_PATH.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            level = _pick_level_from_tags(row.get("tags", ""))
            if not level:
                continue
            entry = {
                "level": level,
                "meaning": (row.get("meaning", "") or "").strip(),
                "reading": _clean_reading(row.get("reading", "")),
            }
            for key in {_clean_key(row.get("expression", "")), _clean_reading(row.get("reading", ""))}:
                if key:
                    index[key] = _pick_entry(index.get(key), entry)
    return index


def lookup_jlpt_entry(*candidates: str) -> dict:
    index = get_jlpt_index()
    for candidate in candidates:
        key = _clean_key(candidate)
        if key in index:
            return dict(index[key])
    return {"level": "", "meaning": ""}


def lookup_jlpt_level(*candidates: str) -> str:
    return lookup_jlpt_entry(*candidates).get("level", "")


def normalize_jlpt_level(value: str) -> str:
    text = (value or "").strip().upper()
    level = _pick_level_from_tags(text)
    if level:
        return level
    match = re.fullmatch(r"N([1-5])", text)
    return f"N{match.group(1)}" if match else ""

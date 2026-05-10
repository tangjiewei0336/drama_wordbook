from __future__ import annotations

import csv
import re
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "jlpt" / "all.csv"
JLPT_RE = re.compile(r"JLPT_([1-5])")
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
    return candidate if int(candidate[1:]) < int(current[1:]) else current


@lru_cache(maxsize=1)
def get_jlpt_index() -> dict[str, str]:
    index: dict[str, str] = {}
    if not DATA_PATH.exists():
        return index

    with DATA_PATH.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            match = JLPT_RE.search(row.get("tags", ""))
            if not match:
                continue
            level = f"N{match.group(1)}"
            for key in {_clean_key(row.get("expression", "")), _clean_reading(row.get("reading", ""))}:
                if key:
                    index[key] = _pick_level(index.get(key, ""), level)
    return index


def lookup_jlpt_level(*candidates: str) -> str:
    index = get_jlpt_index()
    for candidate in candidates:
        key = _clean_key(candidate)
        if key in index:
            return index[key]
    return ""

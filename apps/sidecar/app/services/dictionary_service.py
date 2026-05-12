from __future__ import annotations

import json
import re
import ssl
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from urllib.parse import quote
from urllib.request import Request, urlopen

import certifi

from app.services.jlpt_service import lookup_jlpt_entry


SSL_CTX = ssl.create_default_context(cafile=certifi.where())
UA = {"User-Agent": "drama-wordbook-sidecar/0.1"}
DICT_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="dict")


def _request_json(url: str, timeout: float = 2.2) -> dict:
    req = Request(url, headers=UA)
    with urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _looks_invalid_zh(text: str) -> bool:
    s = (text or "").strip()
    if not s:
        return True
    if re.fullmatch(r"[\W_。，、！？!?.·…]+", s):
        return True
    return False


_ZH_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")


def meaning_looks_chinese(text: str) -> bool:
    """释义是否以中文为主（用于复习选择题只展示中文）。"""
    s = (text or "").strip()
    if not s:
        return False
    zh = len(_ZH_CHAR_RE.findall(s))
    total = len(s)
    if zh >= 2 and zh / max(total, 1) >= 0.22:
        return True
    return zh >= 1 and total <= 4 and zh / max(total, 1) >= 0.35


def ensure_meaning_chinese(text: str) -> str:
    """将单条释义尽量规范为中文；已是中文则原样返回。"""
    raw = (text or "").strip()
    if not raw:
        return ""
    if meaning_looks_chinese(raw):
        return raw
    zh = _translate_ja_to_zh(raw)
    if zh:
        return zh
    zh2 = _translate_en_to_zh(raw)
    if zh2:
        return zh2
    return raw


@lru_cache(maxsize=4096)
def _translate_ja_to_zh(text: str) -> str:
    q = (text or "").strip()
    if not q:
        return ""
    url = f"https://api.mymemory.translated.net/get?q={quote(q)}&langpair=ja|zh-CN"
    try:
        payload = _request_json(url, timeout=2.2)
        translated = str((payload.get("responseData") or {}).get("translatedText") or "").strip()
        if _looks_invalid_zh(translated):
            return ""
        return translated
    except Exception:
        return ""


@lru_cache(maxsize=4096)
def _translate_en_to_zh(text: str) -> str:
    q = (text or "").strip()
    if not q:
        return ""
    url = f"https://api.mymemory.translated.net/get?q={quote(q)}&langpair=en|zh-CN"
    try:
        payload = _request_json(url, timeout=2.2)
        translated = str((payload.get("responseData") or {}).get("translatedText") or "").strip()
        if _looks_invalid_zh(translated):
            return ""
        return translated
    except Exception:
        return ""


@lru_cache(maxsize=4096)
def _lookup_jisho(keyword: str) -> tuple[str, tuple[str, ...]]:
    url = f"https://jisho.org/api/v1/search/words?keyword={quote(keyword)}"
    try:
        payload = _request_json(url, timeout=2.2)
    except Exception:
        return "", ()

    data = payload.get("data") or []
    if not data:
        return "", ()
    first = data[0]
    japanese = first.get("japanese") or []
    senses = first.get("senses") or []
    reading = ""
    if japanese and isinstance(japanese[0], dict):
        reading = str(japanese[0].get("reading") or "")

    en_meanings: list[str] = []
    for sense in senses[:3]:
        defs = sense.get("english_definitions") or []
        if defs:
            en_meanings.append(", ".join(str(x) for x in defs[:5]))
    return reading, tuple(en_meanings)


@lru_cache(maxsize=4096)
def lookup_dictionary(lemma: str) -> dict:
    started = time.perf_counter()
    keyword = (lemma or "").strip()
    if not keyword:
        return {"lemma": "", "reading": "", "meanings": [], "jlpt_level": ""}

    jlpt_entry = lookup_jlpt_entry(keyword)
    jlpt_meaning = str(jlpt_entry.get("meaning") or "").strip()
    jlpt_reading = str(jlpt_entry.get("reading") or "").strip()
    jlpt_level = str(jlpt_entry.get("level") or "").strip()
    if jlpt_meaning:
        return {"lemma": keyword, "reading": jlpt_reading, "meanings": [jlpt_meaning], "jlpt_level": jlpt_level}

    ja_future = DICT_EXECUTOR.submit(_translate_ja_to_zh, keyword)
    jisho_future = DICT_EXECUTOR.submit(_lookup_jisho, keyword)
    try:
        ja_zh = ja_future.result(timeout=2.4)
    except Exception:
        ja_zh = ""
    try:
        reading, en_meanings = jisho_future.result(timeout=2.4)
    except Exception:
        reading, en_meanings = "", ()
    meanings_zh: list[str] = []

    if jlpt_meaning:
        meanings_zh.append(jlpt_meaning)

    if ja_zh and ja_zh != keyword:
        meanings_zh.append(ja_zh)

    # Common copula normalization fallback for JP learners.
    if not meanings_zh and keyword in {"です", "だ", "でした", "である"}:
        meanings_zh.append("是（判断助动词）")

    # Secondary source: translate Jisho EN gloss into Chinese.
    for en in en_meanings:
        if time.perf_counter() - started > 2.6:
            break
        zh = _translate_en_to_zh(en)
        if zh:
            meanings_zh.append(zh)

    # De-dup and fallback.
    dedup = []
    for m in meanings_zh:
        if m not in dedup:
            dedup.append(m)
    if not dedup and en_meanings:
        dedup = en_meanings

    return {"lemma": keyword, "reading": reading or jlpt_reading, "meanings": dedup[:5], "jlpt_level": jlpt_level}

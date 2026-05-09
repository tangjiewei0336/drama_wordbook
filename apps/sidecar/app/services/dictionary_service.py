from __future__ import annotations

import json
import re
import ssl
from urllib.parse import quote
from urllib.request import Request, urlopen

import certifi


SSL_CTX = ssl.create_default_context(cafile=certifi.where())
UA = {"User-Agent": "drama-wordbook-sidecar/0.1"}


def _request_json(url: str, timeout: float = 5) -> dict:
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


def _translate_ja_to_zh(text: str) -> str:
    q = (text or "").strip()
    if not q:
        return ""
    url = f"https://api.mymemory.translated.net/get?q={quote(q)}&langpair=ja|zh-CN"
    try:
        payload = _request_json(url, timeout=6)
        translated = str((payload.get("responseData") or {}).get("translatedText") or "").strip()
        if _looks_invalid_zh(translated):
            return ""
        return translated
    except Exception:
        return ""


def _translate_en_to_zh(text: str) -> str:
    q = (text or "").strip()
    if not q:
        return ""
    url = f"https://api.mymemory.translated.net/get?q={quote(q)}&langpair=en|zh-CN"
    try:
        payload = _request_json(url, timeout=6)
        translated = str((payload.get("responseData") or {}).get("translatedText") or "").strip()
        if _looks_invalid_zh(translated):
            return ""
        return translated
    except Exception:
        return ""


def _lookup_jisho(keyword: str) -> tuple[str, list[str]]:
    url = f"https://jisho.org/api/v1/search/words?keyword={quote(keyword)}"
    try:
        payload = _request_json(url, timeout=6)
    except Exception:
        return "", []

    data = payload.get("data") or []
    if not data:
        return "", []
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
    return reading, en_meanings


def lookup_dictionary(lemma: str) -> dict:
    keyword = (lemma or "").strip()
    if not keyword:
        return {"lemma": "", "reading": "", "meanings": []}

    reading, en_meanings = _lookup_jisho(keyword)
    meanings_zh: list[str] = []

    # Primary source: JA->ZH translation API.
    ja_zh = _translate_ja_to_zh(keyword)
    if ja_zh:
        meanings_zh.append(ja_zh)

    # Common copula normalization fallback for JP learners.
    if not meanings_zh and keyword in {"です", "だ", "でした", "である"}:
        meanings_zh.append("是（判断助动词）")

    # Secondary source: translate Jisho EN gloss into Chinese.
    for en in en_meanings:
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

    return {"lemma": keyword, "reading": reading, "meanings": dedup[:5]}

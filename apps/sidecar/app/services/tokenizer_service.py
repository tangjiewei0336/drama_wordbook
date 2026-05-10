from __future__ import annotations

import re
from functools import lru_cache

from app.services.jlpt_service import lookup_jlpt_entry

try:
    from sudachipy import Dictionary
except Exception:  # pragma: no cover
    Dictionary = None


WORD_RE = re.compile(r"[ぁ-んァ-ン一-龯ー]+")
CONTENT_POS = {"名詞", "動詞", "形容詞", "形状詞", "副詞", "連体詞"}
POS_LABELS = {
    "名詞": "名词",
    "動詞": "动词",
    "形容詞": "形容词",
    "形状詞": "形容动词",
    "副詞": "副词",
    "連体詞": "连体词",
}
STOP_LEMMAS = {
    # 格助词
    "は",
    "を",
    "が",
    "に",
    "へ",
    "と",
    "で",
    "の",
    "から",
    "まで",
    "より",
    # 係助词/副助词
    "も",
    "や",
    "こそ",
    "しか",
    "さえ",
    "すら",
    "でも",
    "だけ",
    "ばかり",
    "ばっかり",
    "ほど",
    "くらい",
    "ぐらい",
    "など",
    "なんか",
    "なんて",
    "なり",
    "だの",
    "か",
    "とか",
    "って",
    "づつ",
    "ずつ",
    # 接续助词
    "て",
    "で",
    "し",
    "ば",
    "たら",
    "なら",
    "ので",
    "から",
    "けれど",
    "けど",
    "が",
    "のに",
    "ても",
    "でも",
    "ながら",
    "つつ",
    "ところで",
    # 终助词
    "ね",
    "よ",
    "な",
    "ぞ",
    "ぜ",
    "わ",
    "さ",
    "の",
    "かしら",
    "かな",
    "とも",
    "もの",
    "もん",
    # 常见复合助词/形式助词
    "には",
    "では",
    "とは",
    "へは",
    "からは",
    "までは",
    "として",
    "について",
    "にとって",
    "によって",
    "により",
    "において",
    "に対して",
    "にたいして",
    "に関して",
    "にかんして",
    "としては",
    "という",
    "っていう",
    "ものの",
    "こと",
    "もの",
    # 既有非内容词过滤
    "一",
    "です",
    "ます",
    "だ",
    "する",
    # 代词/指示词
    "私",
    "わたし",
    "僕",
    "ぼく",
    "俺",
    "おれ",
    "あたし",
    "あなた",
    "君",
    "きみ",
    "お前",
    "彼",
    "彼女",
    "我々",
    "われわれ",
    "僕ら",
    "俺ら",
    "私たち",
    "あなたたち",
    "彼ら",
    "彼女たち",
    "これ",
    "それ",
    "あれ",
    "どれ",
    "ここ",
    "そこ",
    "あそこ",
    "どこ",
    "こちら",
    "そちら",
    "あちら",
    "どちら",
    "こっち",
    "そっち",
    "あっち",
    "どっち",
    "こんな",
    "そんな",
    "あんな",
    "どんな",
    "この",
    "その",
    "あの",
    "どの",
    "こう",
    "そう",
    "ああ",
    "どう",
    "誰",
    "だれ",
    "何",
    "なに",
    "なん",
    "いつ",
    "いずれ",
    "どなた",
    "どいつ",
    "こいつ",
    "そいつ",
    "あいつ",
}


@lru_cache(maxsize=1)
def get_tokenizer():
    if Dictionary is None:
        return None
    return Dictionary().create()


def _meanings_from_jlpt(entry: dict) -> list[str]:
    meaning = (entry.get("meaning") or "").strip()
    return [meaning] if meaning else []


def _strip_trailing_na(value: str) -> str:
    text = (value or "").strip()
    return text[:-1] if len(text) > 1 and text.endswith("な") else text


def _strip_trailing_reading_na(value: str) -> str:
    text = (value or "").strip()
    return text[:-1] if len(text) > 1 and text.endswith(("な", "ナ")) else text


def _normalize_fallback_form(surface: str) -> tuple[str, dict]:
    stripped = _strip_trailing_na(surface)
    if stripped != surface:
        stripped_entry = lookup_jlpt_entry(stripped)
        if stripped_entry.get("level") or stripped_entry.get("meaning"):
            return stripped, stripped_entry
    return surface, lookup_jlpt_entry(surface)


def _pos_label(pos: tuple) -> str:
    if not pos:
        return ""
    return POS_LABELS.get(str(pos[0]), str(pos[0]))


def tokenize_ja(text: str) -> list[dict]:
    tokenizer = get_tokenizer()
    if tokenizer is None:
        # Fallback for POC when SudachiPy not installed.
        result = []
        for w in WORD_RE.findall(text):
            if w in STOP_LEMMAS:
                continue
            dictionary_form, jlpt_entry = _normalize_fallback_form(w)
            result.append({
                "surface": w,
                "dictionary_form": dictionary_form,
                "reading": "",
                "pos": "",
                "jlpt_level": jlpt_entry.get("level", ""),
                "meanings": _meanings_from_jlpt(jlpt_entry),
            })
        return result

    tokens = tokenizer.tokenize(text)
    result = []
    for t in tokens:
        surface = t.surface()
        if not WORD_RE.match(surface):
            continue
        dictionary_form = t.dictionary_form()
        if dictionary_form in STOP_LEMMAS or surface in STOP_LEMMAS:
            continue
        try:
            pos = t.part_of_speech()
        except Exception:
            pos = ()
        if pos and pos[0] not in CONTENT_POS:
            continue
        if len(pos) > 1 and pos[1] == "非自立可能":
            continue
        if len(pos) > 1 and pos[1] == "代名詞":
            continue
        reading = ""
        try:
            reading = t.reading_form()
        except Exception:
            reading = ""
        if pos and pos[0] == "形状詞":
            dictionary_form = _strip_trailing_na(dictionary_form)
            reading = _strip_trailing_reading_na(reading)
        jlpt_entry = lookup_jlpt_entry(dictionary_form, surface, reading)
        result.append(
            {
                "surface": surface,
                "dictionary_form": dictionary_form,
                "reading": reading,
                "pos": _pos_label(pos),
                "jlpt_level": jlpt_entry.get("level", ""),
                "meanings": _meanings_from_jlpt(jlpt_entry),
            }
        )
    return result

from __future__ import annotations

import re
from functools import lru_cache

from app.services.jlpt_service import lookup_jlpt_level

try:
    from sudachipy import Dictionary
except Exception:  # pragma: no cover
    Dictionary = None


WORD_RE = re.compile(r"[ぁ-んァ-ン一-龯ー]+")
CONTENT_POS = {"名詞", "動詞", "形容詞", "形状詞", "副詞", "連体詞"}
STOP_LEMMAS = {
    "は",
    "を",
    "が",
    "に",
    "へ",
    "と",
    "で",
    "の",
    "も",
    "や",
    "から",
    "まで",
    "より",
    "です",
    "ます",
    "だ",
    "する",
}


@lru_cache(maxsize=1)
def get_tokenizer():
    if Dictionary is None:
        return None
    return Dictionary().create()


def tokenize_ja(text: str) -> list[dict]:
    tokenizer = get_tokenizer()
    if tokenizer is None:
        # Fallback for POC when SudachiPy not installed.
        return [
            {
                "surface": w,
                "dictionary_form": w,
                "reading": "",
                "jlpt_level": lookup_jlpt_level(w),
            }
            for w in WORD_RE.findall(text)
        ]

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
        reading = ""
        try:
            reading = t.reading_form()
        except Exception:
            reading = ""
        result.append(
            {
                "surface": surface,
                "dictionary_form": dictionary_form,
                "reading": reading,
                "jlpt_level": lookup_jlpt_level(dictionary_form, surface, reading),
            }
        )
    return result

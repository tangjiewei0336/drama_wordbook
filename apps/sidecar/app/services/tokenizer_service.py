from __future__ import annotations

import re
from functools import lru_cache

try:
    from sudachipy import Dictionary
except Exception:  # pragma: no cover
    Dictionary = None


WORD_RE = re.compile(r"[ぁ-んァ-ン一-龯ー]+")


@lru_cache(maxsize=1)
def get_tokenizer():
    if Dictionary is None:
        return None
    return Dictionary().create()


def tokenize_ja(text: str) -> list[dict]:
    tokenizer = get_tokenizer()
    if tokenizer is None:
        # Fallback for POC when SudachiPy not installed.
        return [{"surface": w, "dictionary_form": w} for w in WORD_RE.findall(text)]

    tokens = tokenizer.tokenize(text)
    return [
        {"surface": t.surface(), "dictionary_form": t.dictionary_form()}
        for t in tokens
        if WORD_RE.match(t.surface())
    ]

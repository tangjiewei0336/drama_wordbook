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
SURU_FORMS = {
    "する",
    "し",
    "して",
    "した",
    "します",
    "しました",
    "しない",
    "しません",
    "しよう",
    "すれば",
    "される",
    "させる",
}
POS_LABELS = {
    "名詞": "名词",
    "動詞": "动词",
    "形容詞": "形容词",
    "形状詞": "形容动词",
    "副詞": "副词",
    "連体詞": "连体词",
    "助詞": "助词",
    "助動詞": "助动词",
    "接続詞": "接续词",
    "感動詞": "感叹词",
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


def _normalize_analysis_token(token: dict) -> dict:
    if token.get("surface") == "つて":
        return {
            **token,
            "surface": "って",
            "dictionary_form": "って",
            "reading": "ッテ",
            "pos": "助词",
            "jlpt_level": "",
            "meanings": [],
        }
    return token


def _is_suru_stem(token: dict) -> bool:
    if token.get("pos") != "名词":
        return False
    surface = str(token.get("surface", "") or "")
    dictionary_form = str(token.get("dictionary_form", "") or surface)
    if not surface:
        return False
    return bool(lookup_jlpt_entry(f"{dictionary_form}する", dictionary_form, surface).get("level") or surface.endswith(("化", "視")))


def _is_suru_form(token: dict) -> bool:
    surface = str(token.get("surface", "") or "")
    dictionary_form = str(token.get("dictionary_form", "") or "")
    return surface in SURU_FORMS or dictionary_form == "する"


def _is_te_connector(token: dict) -> bool:
    return str(token.get("surface", "") or "") in {"て", "で"}


def _is_te_verb_stem(token: dict) -> bool:
    if token.get("pos") != "动词":
        return False
    surface = str(token.get("surface", "") or "")
    dictionary_form = str(token.get("dictionary_form", "") or "")
    if not surface or not dictionary_form:
        return False
    return surface != dictionary_form


def _is_verb_tail(token: dict) -> bool:
    surface = str(token.get("surface", "") or "")
    dictionary_form = str(token.get("dictionary_form", "") or "")
    pos = str(token.get("pos", "") or "")
    if pos in {"助动词", "助词"} and surface in {
        "て",
        "で",
        "た",
        "だ",
        "たい",
        "たく",
        "ない",
        "なかっ",
        "ぬ",
        "ん",
        "ます",
        "まし",
        "れる",
        "れ",
        "られる",
        "られ",
        "せる",
        "せ",
        "させる",
        "させ",
    }:
        return True
    if pos == "助动词" and surface in {"てる", "でる", "ている", "でいる", "ちゃう", "ちゃっ", "じゃう", "じゃっ"}:
        return True
    if pos == "动词" and dictionary_form in {"いる", "おる", "くる", "いく", "しまう"}:
        return True
    return False


def _merge_verb_tail(tokens: list[dict], start: int) -> tuple[dict | None, int]:
    current = tokens[start]
    if current.get("pos") != "动词":
        return None, 0
    surfaces = [str(current.get("surface", "") or "")]
    readings = [str(current.get("reading", "") or "")]
    consumed = 1
    idx = start + 1
    while idx < len(tokens) and _is_verb_tail(tokens[idx]):
        tail = tokens[idx]
        surfaces.append(str(tail.get("surface", "") or ""))
        readings.append(str(tail.get("reading", "") or ""))
        consumed += 1
        idx += 1
    if consumed <= 1:
        return None, 0
    return (
        {
            **current,
            "surface": "".join(surfaces),
            "reading": "".join(readings),
            "pos": "动词",
        },
        consumed,
    )


def merge_phrase_tokens(tokens: list[dict]) -> list[dict]:
    merged: list[dict] = []
    i = 0
    while i < len(tokens):
        current = tokens[i]
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        third = tokens[i + 2] if i + 2 < len(tokens) else None
        if (
            nxt
            and third
            and current.get("surface") == "と"
            and nxt.get("surface") == "こ"
            and third.get("surface") == "ない"
        ):
            merged.append(
                {
                    "surface": "とこ",
                    "dictionary_form": "ところ",
                    "reading": "トコ",
                    "pos": "名词",
                    "jlpt_level": "",
                    "meanings": [],
                }
            )
            i += 2
            continue
        verb_chain, consumed = _merge_verb_tail(tokens, i)
        if verb_chain and consumed:
            merged.append(verb_chain)
            i += consumed
            continue
        if nxt and _is_te_verb_stem(current) and _is_te_connector(nxt):
            merged.append(
                {
                    **current,
                    "surface": f"{current.get('surface', '')}{nxt.get('surface', '')}",
                    "reading": f"{current.get('reading', '')}{nxt.get('reading', '')}",
                    "pos": "动词",
                }
            )
            i += 2
            continue
        if nxt and _is_suru_stem(current) and _is_suru_form(nxt):
            consumed = 2
            surfaces = [str(current.get("surface", "") or ""), str(nxt.get("surface", "") or "")]
            readings = [str(current.get("reading", "") or ""), str(nxt.get("reading", "") or "")]
            third = tokens[i + 2] if i + 2 < len(tokens) else None
            if str(nxt.get("surface", "") or "") == "し" and third and _is_te_connector(third):
                surfaces.append(str(third.get("surface", "") or ""))
                readings.append(str(third.get("reading", "") or ""))
                consumed = 3
            dictionary_form = f"{current.get('dictionary_form') or current.get('surface')}する"
            reading = "".join(readings)
            jlpt_entry = lookup_jlpt_entry(dictionary_form, current.get("dictionary_form", ""), current.get("surface", ""), reading)
            meanings = _meanings_from_jlpt(jlpt_entry) or list(current.get("meanings") or [])
            merged.append(
                {
                    "surface": "".join(surfaces),
                    "dictionary_form": dictionary_form,
                    "reading": reading,
                    "pos": "动词",
                    "jlpt_level": jlpt_entry.get("level", "") or current.get("jlpt_level", ""),
                    "meanings": meanings,
                }
            )
            i += consumed
            continue
        merged.append(current)
        i += 1
    return merged


def tokenize_ja(text: str, include_stop: bool = False) -> list[dict]:
    tokenizer = get_tokenizer()
    if tokenizer is None:
        # Fallback for POC when SudachiPy not installed.
        result = []
        for w in WORD_RE.findall(text):
            if not include_stop and w in STOP_LEMMAS:
                continue
            dictionary_form, jlpt_entry = _normalize_fallback_form(w)
            result.append(_normalize_analysis_token({
                "surface": w,
                "dictionary_form": dictionary_form,
                "reading": "",
                "pos": "",
                "jlpt_level": jlpt_entry.get("level", ""),
                "meanings": _meanings_from_jlpt(jlpt_entry),
            }))
        return merge_phrase_tokens(result) if include_stop else result

    tokens = tokenizer.tokenize(text)
    result = []
    for t in tokens:
        surface = t.surface()
        if not WORD_RE.match(surface):
            continue
        dictionary_form = t.dictionary_form()
        if not include_stop and (dictionary_form in STOP_LEMMAS or surface in STOP_LEMMAS):
            continue
        try:
            pos = t.part_of_speech()
        except Exception:
            pos = ()
        if not include_stop and pos and pos[0] not in CONTENT_POS:
            continue
        if not include_stop and len(pos) > 1 and pos[1] == "非自立可能":
            continue
        if not include_stop and len(pos) > 1 and pos[1] == "代名詞":
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
            _normalize_analysis_token({
                "surface": surface,
                "dictionary_form": dictionary_form,
                "reading": reading,
                "pos": _pos_label(pos),
                "jlpt_level": jlpt_entry.get("level", ""),
                "meanings": _meanings_from_jlpt(jlpt_entry),
            })
        )
    return merge_phrase_tokens(result) if include_stop else result

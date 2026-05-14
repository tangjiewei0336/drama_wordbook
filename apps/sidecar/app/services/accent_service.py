from __future__ import annotations

import re
import ssl
from functools import lru_cache
from pathlib import Path

import certifi

ssl._create_default_https_context = lambda: ssl.create_default_context(cafile=certifi.where())

try:
    import pyopenjtalk
except Exception:  # pragma: no cover
    pyopenjtalk = None


ACCENT_RE = re.compile(r"/A:([-0-9]+)\+([-0-9]+)\+([-0-9]+)")


def _pyopenjtalk_has_dictionary() -> bool:
    if pyopenjtalk is None:
        return False
    raw = getattr(pyopenjtalk, "OPEN_JTALK_DICT_DIR", b"")
    if isinstance(raw, bytes):
        path = raw.decode("utf-8", errors="ignore")
    else:
        path = str(raw or "")
    return bool(path and (Path(path) / "sys.dic").exists())


@lru_cache(maxsize=4096)
def lookup_pitch_accent(text: str) -> int | None:
    """Best-effort pitch accent lookup.

    OpenJTalk full-context labels expose accent phrase metadata. We keep this
    optional because CI/dev environments may not have pyopenjtalk installed.
    """
    key = (text or "").strip()
    if not key or not _pyopenjtalk_has_dictionary():
        return None
    try:
        frontend_items = pyopenjtalk.run_frontend(key)
    except Exception:
        frontend_items = []

    # Prefer OpenJTalk frontend "acc" field, which is the lexical accent nucleus.
    if frontend_items:
        for item in frontend_items:
            if str(item.get("string") or "").strip() != key:
                continue
            acc = item.get("acc")
            if isinstance(acc, int) and acc >= 0:
                return acc
        first_acc = frontend_items[0].get("acc")
        if isinstance(first_acc, int) and first_acc >= 0:
            return first_acc

    try:
        labels = pyopenjtalk.extract_fullcontext(key)
    except Exception:
        return None

    # Fallback parser for environments where frontend fields are unavailable.
    for label in labels:
        match = ACCENT_RE.search(label)
        if not match:
            continue
        try:
            accent = int(match.group(2))
        except Exception:
            continue
        if accent >= 0:
            return accent
    return None

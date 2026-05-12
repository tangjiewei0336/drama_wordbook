from __future__ import annotations

import base64
import io
import logging
import os
import re
import traceback
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

logger = logging.getLogger("wordbook.sidecar.ocr")


def _ensure_paddleocr_base_dir() -> None:
    """PaddleOCR 在首次 import 时读取 PADDLE_OCR_BASE_DIR；默认 ~/.paddleocr 在无写 HOME 时会失败。"""
    explicit = (
        os.environ.get("DRAMA_WORDBOOK_PADDLEOCR_HOME")
        or os.environ.get("PADDLE_OCR_BASE_DIR")
        or ""
    ).strip()
    if explicit:
        base = Path(explicit).expanduser().resolve()
        base.mkdir(parents=True, exist_ok=True)
        os.environ["PADDLE_OCR_BASE_DIR"] = str(base) + os.sep
        return
    root = Path(__file__).resolve().parent.parent / "data" / "paddleocr"
    root.mkdir(parents=True, exist_ok=True)
    os.environ["PADDLE_OCR_BASE_DIR"] = str(root) + os.sep


_ensure_paddleocr_base_dir()

# Surface the real import error (missing wheel, broken hidden import, ABI mismatch …)
# instead of swallowing it and showing the generic "not available" message later.
_PADDLEOCR_IMPORT_ERROR: str = ""
_PADDLEOCR_IMPORT_TRACEBACK: str = ""


def _write_ocr_import_error_to_disk(message: str, tb: str) -> None:
    """Best-effort log to a stable on-disk path so packaged builds still leave a trace."""
    try:
        root = Path(__file__).resolve().parent.parent / "data"
        root.mkdir(parents=True, exist_ok=True)
        with (root / "ocr_import_error.log").open("w", encoding="utf-8") as fh:
            fh.write(message + "\n\n")
            fh.write(tb)
    except Exception:
        # Never let logging crash the sidecar boot.
        pass


try:
    from paddleocr import PaddleOCR  # type: ignore[assignment]
except Exception as _ocr_import_exc:  # pragma: no cover - dependency runtime check
    PaddleOCR = None  # type: ignore[assignment]
    _PADDLEOCR_IMPORT_ERROR = f"{type(_ocr_import_exc).__name__}: {_ocr_import_exc}"
    _PADDLEOCR_IMPORT_TRACEBACK = traceback.format_exc()
    logger.exception("PaddleOCR import failed; OCR endpoint will return 500")
    try:
        traceback.print_exc()
    except Exception:
        pass
    _write_ocr_import_error_to_disk(_PADDLEOCR_IMPORT_ERROR, _PADDLEOCR_IMPORT_TRACEBACK)


def get_paddleocr_import_traceback() -> str:
    return _PADDLEOCR_IMPORT_TRACEBACK


def get_paddleocr_import_error() -> str:
    """Expose the import-time error string (for /health and clearer 500 detail)."""
    return _PADDLEOCR_IMPORT_ERROR


JA_RE = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff]")
ZH_RE = re.compile(r"[\u4e00-\u9fff]")
MAX_IMAGE_SIDE = 1280


def _split_lang_lines(lines: list[str]) -> tuple[list[str], list[str]]:
    ja_lines: list[str] = []
    zh_lines: list[str] = []
    for line in lines:
        has_ja = bool(JA_RE.search(line))
        has_zh = bool(ZH_RE.search(line))
        if has_ja:
            ja_lines.append(line)
        if has_zh:
            zh_lines.append(line)
    return ja_lines, zh_lines


@lru_cache(maxsize=1)
def get_ocr_engine():
    if PaddleOCR is None:
        return None
    try:
        # PaddleOCR 2.x: PP-OCR + angle classifier; show_log=False keeps stderr quiet.
        return PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
    except Exception as exc:  # pragma: no cover - env specific
        logger.exception("PaddleOCR initialization failed")
        raise RuntimeError(
            f"PaddleOCR failed to start: {type(exc).__name__}: {exc}. "
            "If using a venv, reinstall: cd apps/sidecar && pip install -e . "
            "(expects paddleocr>=2.10,<3 and paddlepaddle)."
        ) from exc


def decode_base64_image(image_base64: str) -> Image.Image:
    image_bytes = base64.b64decode(image_base64)
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def _resize_for_ocr(image: Image.Image) -> Image.Image:
    width, height = image.size
    longest_side = max(width, height)
    if longest_side <= MAX_IMAGE_SIDE:
        return image

    ratio = MAX_IMAGE_SIDE / float(longest_side)
    resized = image.resize(
        (int(width * ratio), int(height * ratio)),
        Image.Resampling.BILINEAR,
    )
    return resized


def _crop_with_viewport_hint(
    image: Image.Image, crop_rect: dict | None, viewport: dict | None
) -> Image.Image:
    if not crop_rect or not viewport:
        return image

    vp_w = float(viewport.get("width", 0) or 0)
    vp_h = float(viewport.get("height", 0) or 0)
    if vp_w <= 0 or vp_h <= 0:
        return image

    x = float(crop_rect.get("x", 0) or 0)
    y = float(crop_rect.get("y", 0) or 0)
    w = float(crop_rect.get("width", 0) or 0)
    h = float(crop_rect.get("height", 0) or 0)
    if w <= 0 or h <= 0:
        return image

    img_w, img_h = image.size
    scale_x = img_w / vp_w
    scale_y = img_h / vp_h

    left = max(0, int(x * scale_x))
    top = max(0, int(y * scale_y))
    right = min(img_w, int((x + w) * scale_x))
    bottom = min(img_h, int((y + h) * scale_y))

    if right - left < 20 or bottom - top < 20:
        return image
    return image.crop((left, top, right, bottom))


def _extract_blocks_from_predict_result(result: list) -> list[dict]:
    raw_blocks: list[dict] = []
    for page in result or []:
        rec_texts = []
        rec_scores = []
        if isinstance(page, dict):
            rec_texts = page.get("rec_texts", []) or []
            rec_scores = page.get("rec_scores", []) or []
        else:
            # PaddleOCR may return custom mapping-like objects.
            try:
                rec_texts = page.get("rec_texts", []) or []
                rec_scores = page.get("rec_scores", []) or []
            except Exception:
                continue

        for idx, text in enumerate(rec_texts):
            text = str(text).strip()
            if not text:
                continue
            score = float(rec_scores[idx]) if idx < len(rec_scores) else 0.0
            raw_blocks.append({"text": text, "score": score})
    return raw_blocks


def _extract_blocks_from_legacy_ocr_result(result: list) -> list[dict]:
    raw_blocks: list[dict] = []
    for group in result or []:
        if not isinstance(group, (list, tuple)):
            continue
        for item in group or []:
            if (
                not isinstance(item, (list, tuple))
                or len(item) < 2
                or not isinstance(item[1], (list, tuple))
                or len(item[1]) < 2
            ):
                continue
            text = str(item[1][0]).strip()
            if not text:
                continue
            score = float(item[1][1])
            raw_blocks.append({"text": text, "score": score})
    return raw_blocks


def run_ocr(
    image_base64: str, crop_rect: dict | None = None, viewport: dict | None = None
) -> tuple[list[str], list[str], list[dict]]:
    engine = get_ocr_engine()
    if engine is None:
        detail = _PADDLEOCR_IMPORT_ERROR or "module import returned None"
        raise RuntimeError(
            "PaddleOCR is not available ("
            + detail
            + "). 若是 dev 环境，请在 apps/sidecar 下执行 `pip install -e .`；"
            + "若是打包版本，请检查侧车日志里 PaddleOCR / paddlepaddle 的 import 错误。"
        )

    image = decode_base64_image(image_base64)
    image = _crop_with_viewport_hint(image, crop_rect=crop_rect, viewport=viewport)
    image = _resize_for_ocr(image)
    image_np = np.array(image)

    raw_blocks: list[dict] = []

    # PaddleOCR 3.x path (primary)
    if hasattr(engine, "predict"):
        result = engine.predict(
            image_np,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_det_limit_side_len=960,
            text_det_limit_type="max",
            text_rec_score_thresh=0.25,
        )
        raw_blocks = _extract_blocks_from_predict_result(result)
    elif hasattr(engine, "ocr"):
        result = engine.ocr(image_np)
        # Try modern dict-like output first.
        raw_blocks = _extract_blocks_from_predict_result(result)
        # Then fallback to very old legacy nested-list format.
        if not raw_blocks:
            raw_blocks = _extract_blocks_from_legacy_ocr_result(result)

    lines = [b["text"] for b in raw_blocks]
    ja_lines, zh_lines = _split_lang_lines(lines)
    if not ja_lines and lines:
        logger.warning("ja_lines empty; raw text sample=%s", " | ".join(lines[:6]))
    return ja_lines, zh_lines, raw_blocks

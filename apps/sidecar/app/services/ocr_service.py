from __future__ import annotations

import base64
import io
import logging
import re
from functools import lru_cache

import numpy as np
from PIL import Image

try:
    from paddleocr import PaddleOCR
except Exception:  # pragma: no cover - dependency runtime check
    PaddleOCR = None


JA_RE = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff]")
ZH_RE = re.compile(r"[\u4e00-\u9fff]")
MAX_IMAGE_SIDE = 1280
logger = logging.getLogger("wordbook.sidecar.ocr")


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
        # lang="ch" contains Chinese and can often handle Japanese subtitles in practice.
        return PaddleOCR(use_angle_cls=True, lang="ch")
    except Exception as exc:  # pragma: no cover - env specific
        logger.exception("PaddleOCR initialization failed (%s)", exc)
        raise RuntimeError(
            "OCR engine failed to start (missing PaddleX/OpenCV OCR deps?). "
            "Reinstall sidecar deps: pip install -e 'apps/sidecar' and ensure "
            "paddlex[ocr-core] is installed."
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
        raise RuntimeError(
            "PaddleOCR is not available. Install dependencies in apps/sidecar first."
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

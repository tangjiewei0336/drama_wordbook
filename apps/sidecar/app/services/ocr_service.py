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
    """PaddleOCR 在首次 import 时读取 PADDLE_OCR_BASE_DIR；默认 ~/.paddleocr 在无写 HOME 时会失败。

    Resolution order: explicit override → packaged user-data dir → dev fallback.
    The user-data option means OCR model weights (~hundreds of MB) survive app
    upgrades, instead of being re-downloaded on every release.
    """
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
    data_dir = os.environ.get("DRAMA_WORDBOOK_DATA_DIR", "").strip()
    if data_dir:
        base = Path(data_dir).expanduser().resolve() / "paddleocr"
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


def get_ocr_lang() -> str:
    """Expose the default recognition language (lang=) for /health."""
    return _default_ocr_lang()


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


def _default_ocr_lang() -> str:
    """Resolve the fallback recognition model from env / hardcoded default.

    Default ``ch`` matches the upstream PaddleOCR 3.x multilingual recognizer.
    Callers can override per request via ``OcrRecognizeRequest.lang`` (e.g.
    ``japan`` for kana-heavy frames); this is what powers the Bilibili
    extension's "japanese-on-top / chinese-on-bottom" split mode.
    """
    requested = (os.environ.get("DRAMA_WORDBOOK_OCR_LANG") or "").strip().lower()
    if requested:
        return requested
    return "ch"


def _normalize_lang(lang: str | None) -> str:
    text = str(lang or "").strip().lower()
    return text or _default_ocr_lang()


_ANALYSIS_CONFIG_PATCHED = False


def _patch_paddle_analysis_config() -> None:
    """PaddleX static inference calls ``AnalysisConfig.set_optimization_level(3)``.

    That API exists on paddle 3.0–3.2 but is missing on 2.6.x (too old) and on
    3.3+ (removed / PIR refactor). Add a no-op when absent so OCR pipelines still
    start; quality impact for subtitle OCR is negligible.
    """
    global _ANALYSIS_CONFIG_PATCHED
    if _ANALYSIS_CONFIG_PATCHED:
        return
    _ANALYSIS_CONFIG_PATCHED = True
    try:
        import paddle.base.libpaddle as _lp  # type: ignore[import-not-found]

        cfg_cls = getattr(_lp, "AnalysisConfig", None)
        if cfg_cls is None or hasattr(cfg_cls, "set_optimization_level"):
            return

        def set_optimization_level(self, level: int = 3) -> None:  # noqa: ARG002
            return None

        setattr(cfg_cls, "set_optimization_level", set_optimization_level)
        logger.info("Applied AnalysisConfig.set_optimization_level compatibility shim (paddle+paddlex).")
    except Exception as exc:
        logger.debug("AnalysisConfig shim skipped: %s", exc)


@lru_cache(maxsize=8)
def get_ocr_engine_for_lang(lang: str):
    """Return (and cache) a PaddleOCR engine instance for the given language.

    PaddleOCR 3.x: pipeline tuning happens inside predict(); the constructor
    no longer accepts 2.x's use_angle_cls / show_log. We disable doc-level
    orientation/unwarp because Bilibili subtitles are horizontal screen text
    and the extra steps just slow inference.
    """
    if PaddleOCR is None:
        return None
    _patch_paddle_analysis_config()
    try:
        return PaddleOCR(
            lang=lang,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    except Exception as exc:  # pragma: no cover - env specific
        logger.exception("PaddleOCR initialization failed (lang=%s)", lang)
        hint = ""
        if "set_optimization_level" in str(exc):
            hint = (
                " 若错误含 set_optimization_level：请安装 paddlepaddle 3.0.x–3.2.x（勿用 3.3+），"
                "或升级侧车到已带兼容 shim 的版本后重试。"
            )
        raise RuntimeError(
            f"PaddleOCR failed to start: {type(exc).__name__}: {exc} (lang={lang!r})."
            + hint
            + " 开发环境可执行: cd apps/sidecar && pip install -e . "
            + "(paddleocr>=3,<4, paddlex[ocr-core]>=3.5,<3.6, paddlepaddle>=3,<3.3)。"
        ) from exc


def get_ocr_engine():
    """Backwards-compatible accessor; returns the default-lang engine."""
    return get_ocr_engine_for_lang(_default_ocr_lang())


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
    image_base64: str,
    crop_rect: dict | None = None,
    viewport: dict | None = None,
    lang: str | None = None,
) -> tuple[list[str], list[str], list[dict]]:
    effective_lang = _normalize_lang(lang)
    engine = get_ocr_engine_for_lang(effective_lang)
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
        logger.warning(
            "ja_lines empty (lang=%s); raw text sample=%s",
            effective_lang,
            " | ".join(lines[:6]),
        )
    return ja_lines, zh_lines, raw_blocks

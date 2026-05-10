from __future__ import annotations

import base64
import binascii
import logging
import os
import tempfile
import threading
import traceback
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger("wordbook.sidecar.asr")

try:
    from faster_whisper import WhisperModel
except Exception:  # pragma: no cover
    WhisperModel = None


ASR_LANG_DEFAULT = os.getenv("ASR_LANGUAGE", "ja")
ASR_MODEL_SIZE = os.getenv("ASR_MODEL_SIZE", "small")
ASR_COMPUTE_TYPE = os.getenv("ASR_COMPUTE_TYPE", "int8")
ASR_PRELOAD = os.getenv("ASR_PRELOAD", "0") == "1"
ASR_MODEL_DOWNLOAD_ROOT = os.getenv("ASR_MODEL_DOWNLOAD_ROOT", "")
ASR_LOCAL_FILES_ONLY = os.getenv("ASR_LOCAL_FILES_ONLY", "0") == "1"
ASR_HF_ENDPOINT = os.getenv("ASR_HF_ENDPOINT", "").strip()
ASR_MODEL_TOTAL_BYTES = {
    "tiny": 78_200_000,
    "base": 147_900_000,
    "small": 486_200_000,
    "medium": 1_530_600_000,
    "large-v3": 3_090_800_000,
}
_model_load_lock = threading.Lock()
_model_load_state = {
    "state": "idle",
    "started_at": None,
    "finished_at": None,
    "error": "",
}


def _empty_transcript(language: str) -> dict:
    return {
        "language": language,
        "duration": 0.0,
        "text": "",
        "chunks": [],
    }


def _is_audio_decode_error(exc: Exception) -> bool:
    exc_name = exc.__class__.__name__
    exc_module = exc.__class__.__module__
    message = str(exc)
    return (
        exc_module.startswith("av.")
        or exc_name in {"InvalidDataError", "EOFError"}
        or "Invalid data found when processing input" in message
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _asr_repo_cache_name() -> str:
    return f"models--Systran--faster-whisper-{ASR_MODEL_SIZE}"


def _default_hf_cache_dir() -> Path:
    hf_home = os.getenv("HF_HOME")
    if hf_home:
        return Path(hf_home).expanduser() / "hub"
    return Path(os.getenv("HF_HUB_CACHE", "~/.cache/huggingface/hub")).expanduser()


def _iter_progress_roots() -> list[Path]:
    roots: list[Path] = []
    if ASR_MODEL_DOWNLOAD_ROOT:
        roots.append(Path(ASR_MODEL_DOWNLOAD_ROOT).expanduser())
    roots.append(_default_hf_cache_dir() / _asr_repo_cache_name())
    return roots


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue
    return total


def _download_progress(loaded: bool) -> dict:
    total = ASR_MODEL_TOTAL_BYTES.get(ASR_MODEL_SIZE, 0)
    downloaded = max((_dir_size(root) for root in _iter_progress_roots()), default=0)
    if loaded and total:
        downloaded = max(downloaded, total)
    display_downloaded = min(downloaded, total) if total else downloaded
    percent = 100 if loaded else 0
    if total:
        percent = min(100, int(downloaded * 100 / total))
    return {
        "downloaded_bytes": display_downloaded,
        "total_bytes": total,
        "percent": percent,
        "cache_paths": [str(root) for root in _iter_progress_roots()],
    }


def _configure_hf_endpoint() -> None:
    # Users in some regions may opt into a mirror via ASR_HF_ENDPOINT.
    if ASR_HF_ENDPOINT and not os.getenv("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = ASR_HF_ENDPOINT


@lru_cache(maxsize=1)
def get_asr_model():
    if WhisperModel is None:
        raise RuntimeError(
            "faster-whisper not installed. Run `pip install -e .` in apps/sidecar."
        )
    logger.warning("loading ASR model size=%s compute=%s", ASR_MODEL_SIZE, ASR_COMPUTE_TYPE)
    _configure_hf_endpoint()
    # First load may download model weights.
    return WhisperModel(
        ASR_MODEL_SIZE,
        compute_type=ASR_COMPUTE_TYPE,
        download_root=ASR_MODEL_DOWNLOAD_ROOT or None,
        local_files_only=ASR_LOCAL_FILES_ONLY,
    )


def preload_asr_model() -> None:
    if not ASR_PRELOAD:
        return
    try:
        get_asr_model()
        logger.warning("ASR model ready")
    except Exception as exc:  # pragma: no cover
        logger.exception(
            "ASR preload failed: %s. HF_ENDPOINT=%s local_files_only=%s",
            exc,
            os.getenv("HF_ENDPOINT", ""),
            ASR_LOCAL_FILES_ONLY,
        )


def _load_asr_model_for_management() -> None:
    global _model_load_state
    with _model_load_lock:
        _model_load_state = {
            "state": "loading",
            "started_at": _utc_now(),
            "finished_at": None,
            "error": "",
        }

    try:
        logger.warning("ASR model load requested")
        get_asr_model()
        logger.warning("ASR model load completed")
        with _model_load_lock:
            _model_load_state = {
                **_model_load_state,
                "state": "ready",
                "finished_at": _utc_now(),
                "error": "",
            }
    except Exception as exc:  # pragma: no cover
        logger.exception("ASR model load failed: %s", exc)
        with _model_load_lock:
            _model_load_state = {
                **_model_load_state,
                "state": "error",
                "finished_at": _utc_now(),
                "error": "".join(traceback.format_exception_only(type(exc), exc)).strip(),
            }


def start_asr_model_load() -> dict:
    status = get_asr_status()
    if status["loaded"]:
        with _model_load_lock:
            _model_load_state.update(
                {
                    "state": "ready",
                    "finished_at": _model_load_state.get("finished_at") or _utc_now(),
                    "error": "",
                }
            )
        return get_asr_status()

    with _model_load_lock:
        if _model_load_state.get("state") == "loading":
            return status

    thread = threading.Thread(target=_load_asr_model_for_management, daemon=True)
    thread.start()
    return get_asr_status()


def get_asr_status() -> dict:
    with _model_load_lock:
        load_state = dict(_model_load_state)
    loaded = get_asr_model.cache_info().currsize > 0
    if loaded and load_state.get("state") in {"idle", "loading"}:
        load_state = {**load_state, "state": "ready", "finished_at": load_state.get("finished_at") or _utc_now()}
    progress = _download_progress(loaded)
    return {
        "available": WhisperModel is not None,
        "loaded": loaded,
        "preload": ASR_PRELOAD,
        "model_size": ASR_MODEL_SIZE,
        "compute_type": ASR_COMPUTE_TYPE,
        "download_root": ASR_MODEL_DOWNLOAD_ROOT,
        "local_files_only": ASR_LOCAL_FILES_ONLY,
        "hf_endpoint": os.getenv("HF_ENDPOINT", "") or ASR_HF_ENDPOINT,
        "load_state": load_state,
        "download_progress": progress,
    }


def transcribe_audio_chunk(
    audio_base64: str, language: str = ASR_LANG_DEFAULT, with_vad: bool = True
) -> dict:
    try:
        audio_bytes = base64.b64decode(audio_base64, validate=True)
    except (binascii.Error, ValueError):
        logger.warning("ASR skipped invalid base64 audio payload")
        return _empty_transcript(language)
    if len(audio_bytes) < 2048:
        logger.info("ASR skipped tiny audio payload: %s bytes", len(audio_bytes))
        return _empty_transcript(language)
    model = get_asr_model()
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
        f.write(audio_bytes)
        temp_path = Path(f.name)

    try:
        try:
            segments, info = model.transcribe(
                str(temp_path),
                language=language,
                vad_filter=with_vad,
                vad_parameters={
                    "min_silence_duration_ms": 450,
                    "speech_pad_ms": 160,
                },
                beam_size=5,
                best_of=5,
                temperature=0,
                condition_on_previous_text=False,
            )
        except Exception as exc:
            if _is_audio_decode_error(exc):
                logger.info("ASR skipped undecodable audio chunk: %s", exc)
                return _empty_transcript(language)
            raise
        texts: list[str] = []
        chunks: list[dict] = []
        for seg in segments:
            txt = (seg.text or "").strip()
            if not txt:
                continue
            texts.append(txt)
            chunks.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": txt,
                }
            )
        return {
            "language": str(info.language or language),
            "duration": float(getattr(info, "duration", 0.0) or 0.0),
            "text": " ".join(texts).strip(),
            "chunks": chunks,
        }
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass

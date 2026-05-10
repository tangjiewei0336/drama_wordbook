from __future__ import annotations

from datetime import datetime, timezone
import logging
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.models.schemas import (
    AsrChunk,
    AsrTranscribeRequest,
    AsrTranscribeResponse,
    DictLookupRequest,
    DictLookupResponse,
    JaToken,
    JaTokenizeRequest,
    JaTokenizeResponse,
    OcrBlock,
    OcrRecognizeRequest,
    OcrRecognizeResponse,
    PlaybackContextRequest,
    PlaybackContextResponse,
    VocabAddItemsRequest,
    VocabAddItemsResponse,
    VocabByPlayerNode,
    VocabByTimeResponse,
    VocabHead,
    VocabItem,
    VocabUpdateItemRequest,
)
from app.services.dictionary_service import lookup_dictionary
from app.services.asr_service import (
    get_asr_status,
    preload_asr_model,
    start_asr_model_load,
    transcribe_audio_chunk,
)
from app.services.ocr_service import run_ocr
from app.services.tokenizer_service import tokenize_ja
from app.services.vocab_service import (
    add_items,
    delete_player_group,
    delete_item,
    get_by_player,
    get_by_time,
    get_head_items,
    get_heads,
    get_item_screenshot_path,
    init_db,
    update_item_text,
)

app = FastAPI(title="Drama Wordbook Sidecar", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_playback_store: dict[str, dict] = {}
logger = logging.getLogger("wordbook.sidecar")


@app.on_event("startup")
def on_startup():
    init_db()
    preload_asr_model()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "drama-wordbook-sidecar",
        "time": datetime.now(timezone.utc).isoformat(),
        "asr": get_asr_status(),
    }


@app.post("/ocr/recognize", response_model=OcrRecognizeResponse)
def ocr_recognize(payload: OcrRecognizeRequest):
    try:
        ja_lines, zh_lines, raw_blocks = run_ocr(
            payload.image_base64,
            crop_rect=payload.crop_rect.model_dump() if payload.crop_rect else None,
            viewport=payload.viewport.model_dump() if payload.viewport else None,
        )
        logger.warning(
            "ocr result ja=%s zh=%s raw=%s",
            len(ja_lines),
            len(zh_lines),
            len(raw_blocks),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OCR failed: {exc}") from exc

    return OcrRecognizeResponse(
        ja_lines=ja_lines,
        zh_lines=zh_lines,
        raw_blocks=[OcrBlock(**x) for x in raw_blocks],
    )


@app.post("/ja/tokenize", response_model=JaTokenizeResponse)
def ja_tokenize(payload: JaTokenizeRequest):
    tokens = tokenize_ja(payload.text)
    return JaTokenizeResponse(tokens=[JaToken(**x) for x in tokens])


@app.post("/ja/analyze", response_model=JaTokenizeResponse)
def ja_analyze(payload: JaTokenizeRequest):
    tokens = tokenize_ja(payload.text, include_stop=True)
    return JaTokenizeResponse(tokens=[JaToken(**x) for x in tokens])


@app.post("/playback/context", response_model=PlaybackContextResponse)
def playback_context(payload: PlaybackContextRequest):
    context_id = str(uuid4())
    _playback_store[context_id] = payload.model_dump()
    return PlaybackContextResponse(context_id=context_id)


@app.get("/playback/context/{context_id}")
def get_playback_context(context_id: str):
    data = _playback_store.get(context_id)
    if not data:
        raise HTTPException(status_code=404, detail="context not found")
    return data


@app.post("/vocab/add_items", response_model=VocabAddItemsResponse)
def vocab_add_items(payload: VocabAddItemsRequest):
    head_ids, created_item_ids = add_items([x.model_dump() for x in payload.items])
    return VocabAddItemsResponse(head_ids=head_ids, created_item_ids=created_item_ids)


@app.get("/vocab/heads", response_model=list[VocabHead])
def vocab_heads():
    return [VocabHead(**x) for x in get_heads()]


@app.get("/vocab/heads/{head_id}/items", response_model=list[VocabItem])
def vocab_head_items(head_id: int):
    return [VocabItem(**x) for x in get_head_items(head_id)]


@app.delete("/vocab/items/{item_id}")
def vocab_delete_item(item_id: int):
    if not delete_item(item_id):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True, "deleted_item_id": item_id}


@app.patch("/vocab/items/{item_id}", response_model=VocabItem)
def vocab_update_item(item_id: int, payload: VocabUpdateItemRequest):
    if not update_item_text(item_id, payload.example_ja, payload.example_zh):
        raise HTTPException(status_code=404, detail="item not found")
    items = [x for x in get_by_time() if int(x["id"]) == item_id]
    if not items:
        raise HTTPException(status_code=404, detail="item not found")
    return VocabItem(**items[0])


@app.get("/vocab/view/by-time", response_model=VocabByTimeResponse)
def vocab_view_by_time():
    return VocabByTimeResponse(items=[VocabItem(**x) for x in get_by_time()])


@app.get("/vocab/view/by-player", response_model=list[VocabByPlayerNode])
def vocab_view_by_player():
    nodes = get_by_player()
    return [
        VocabByPlayerNode(
            platform=n["platform"],
            source=n["source"],
            series_name=n["series_name"],
            episode_name=n["episode_name"],
            items=[VocabItem(**x) for x in n["items"]],
        )
        for n in nodes
    ]


@app.delete("/vocab/view/by-player")
def vocab_delete_player_group(platform: str, source: str, series_name: str, episode_name: str):
    deleted_count = delete_player_group(platform, source, series_name, episode_name)
    if deleted_count <= 0:
        raise HTTPException(status_code=404, detail="group not found")
    return {"ok": True, "deleted_count": deleted_count}


@app.get("/vocab/items/{item_id}/screenshot")
def vocab_item_screenshot(item_id: int):
    path = get_item_screenshot_path(item_id)
    if not path:
        raise HTTPException(status_code=404, detail="screenshot not found")
    return FileResponse(path)


@app.post("/dict/lookup", response_model=DictLookupResponse)
def dict_lookup(payload: DictLookupRequest):
    result = lookup_dictionary(payload.lemma)
    return DictLookupResponse(**result)


@app.post("/asr/transcribe", response_model=AsrTranscribeResponse)
def asr_transcribe(payload: AsrTranscribeRequest):
    result = transcribe_audio_chunk(
        payload.audio_base64,
        language=payload.language,
        with_vad=payload.with_vad,
    )
    return AsrTranscribeResponse(
        language=result["language"],
        duration=result["duration"],
        text=result["text"],
        chunks=[AsrChunk(**x) for x in result["chunks"]],
    )


@app.get("/asr/status")
def asr_status():
    return get_asr_status()


@app.post("/asr/model/load")
def asr_model_load():
    return start_asr_model_load()

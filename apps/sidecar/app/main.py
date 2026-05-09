from __future__ import annotations

from datetime import datetime, timezone
import logging
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.models.schemas import (
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
)
from app.services.dictionary_service import lookup_dictionary
from app.services.ocr_service import run_ocr
from app.services.tokenizer_service import tokenize_ja
from app.services.vocab_service import (
    add_items,
    get_by_player,
    get_by_time,
    get_head_items,
    get_heads,
    get_item_screenshot_path,
    init_db,
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


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "drama-wordbook-sidecar",
        "time": datetime.now(timezone.utc).isoformat(),
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


@app.get("/vocab/view/by-time", response_model=VocabByTimeResponse)
def vocab_view_by_time():
    return VocabByTimeResponse(items=[VocabItem(**x) for x in get_by_time()])


@app.get("/vocab/view/by-player", response_model=list[VocabByPlayerNode])
def vocab_view_by_player():
    nodes = get_by_player()
    return [
        VocabByPlayerNode(
            platform=n["platform"],
            series_name=n["series_name"],
            episode_name=n["episode_name"],
            items=[VocabItem(**x) for x in n["items"]],
        )
        for n in nodes
    ]


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

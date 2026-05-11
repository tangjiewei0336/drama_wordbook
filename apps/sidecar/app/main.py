from __future__ import annotations

from concurrent.futures import TimeoutError as FutureTimeoutError
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
    PartnerRequestPayload,
    PlaybackContextRequest,
    PlaybackContextResponse,
    Profile,
    SentenceAddRequest,
    SentenceListResponse,
    SentenceRecord,
    SentenceUpdateRequest,
    ShareSentenceRequest,
    SyncConflictResolveRequest,
    SyncConfig,
    SyncConfigUpdateRequest,
    SyncLoginRequest,
    SyncRunRequest,
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
    accept_partner_request,
    add_items,
    add_sentence,
    clear_db,
    create_partner_request,
    delete_player_group,
    delete_item,
    delete_sentence,
    get_activity,
    get_by_player,
    get_by_time,
    get_profile,
    get_partner_state,
    get_sentence,
    get_sentence_screenshot_path,
    get_head_items,
    get_heads,
    get_item_screenshot_path,
    get_recent_series,
    get_sentences,
    get_sync_config,
    get_sync_conflicts,
    get_vocab_count,
    get_unread_shares,
    init_db,
    is_sync_logged_in,
    login_sync_server,
    logout_sync_server,
    register_sync_server,
    pull_remote_changes,
    resolve_sync_conflict,
    save_profile,
    save_sync_config,
    schedule_sync,
    share_sentence_to_partner,
    update_sentence,
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


@app.post("/sentences", response_model=SentenceRecord)
def sentence_add(payload: SentenceAddRequest):
    sentence_id = add_sentence(payload.model_dump())
    items, _ = get_sentences(limit=1, offset=0)
    match = [x for x in items if int(x["id"]) == sentence_id]
    if not match:
        raise HTTPException(status_code=500, detail="sentence created but not found")
    return SentenceRecord(**match[0])


@app.get("/sentences", response_model=SentenceListResponse)
def sentence_list(limit: int = 100, offset: int = 0):
    items, total = get_sentences(limit=limit, offset=offset)
    return SentenceListResponse(
        items=[SentenceRecord(**x) for x in items],
        total=total,
        limit=max(1, min(int(limit or 100), 500)),
        offset=max(0, int(offset or 0)),
    )


@app.patch("/sentences/{sentence_id}", response_model=SentenceRecord)
def sentence_update(sentence_id: int, payload: SentenceUpdateRequest):
    if not update_sentence(sentence_id, payload.example_ja, payload.example_zh, payload.tags):
        raise HTTPException(status_code=404, detail="sentence not found")
    item = get_sentence(sentence_id)
    if not item:
        raise HTTPException(status_code=404, detail="sentence not found")
    return SentenceRecord(**item)


@app.delete("/sentences/{sentence_id}")
def sentence_delete(sentence_id: int):
    result = delete_sentence(sentence_id)
    if not result.get("deleted"):
        raise HTTPException(status_code=404, detail="sentence not found")
    return {"ok": True, "deleted_sentence_id": sentence_id, "deleted_word_count": int(result.get("deleted_word_count") or 0)}


@app.get("/sentences/{sentence_id}/screenshot")
def sentence_screenshot(sentence_id: int):
    path = get_sentence_screenshot_path(sentence_id)
    if not path:
        raise HTTPException(status_code=404, detail="screenshot not found")
    return FileResponse(path)


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
def vocab_view_by_time(limit: int = 100, offset: int = 0):
    return VocabByTimeResponse(items=[VocabItem(**x) for x in get_by_time(limit=limit, offset=offset)])


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


@app.get("/space")
def drama_space():
    partner_state = get_partner_state()
    return {
        "profile": get_profile(),
        "activity": get_activity(365),
        "recent_series": get_recent_series(8),
        "total_words": get_vocab_count(),
        "unread_shares": get_unread_shares(),
        "partner": partner_state.get("partner"),
        "can_send_partner_request": bool(partner_state.get("can_send_request")),
        "partner_inbound_requests": partner_state.get("inbound_requests") or [],
        "partner_outbound_requests": partner_state.get("outbound_requests") or [],
    }


@app.get("/profile", response_model=Profile)
def profile_get():
    return Profile(**get_profile())


@app.put("/profile", response_model=Profile)
def profile_put(payload: Profile):
    try:
        saved = save_profile(payload.model_dump(), require_login=True, push_remote=True)
        return Profile(**saved)
    except Exception as exc:
        status = 401 if not is_sync_logged_in() else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/shares")
def share_sentence(payload: ShareSentenceRequest):
    try:
        return share_sentence_to_partner(payload.sentence_id, payload.recipient_username, payload.comment)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/sync/config", response_model=SyncConfig)
def sync_config_get():
    return SyncConfig(**get_sync_config())


@app.patch("/sync/config", response_model=SyncConfig)
def sync_config_patch(payload: SyncConfigUpdateRequest):
    interval = max(0, min(int(payload.auto_sync_interval_minutes or 0), 1440))
    return SyncConfig(**save_sync_config({"auto_sync_interval_minutes": interval}))


@app.post("/sync/login", response_model=SyncConfig)
def sync_login(payload: SyncLoginRequest):
    try:
        config = login_sync_server(payload.server_url, payload.username, payload.password)
        return SyncConfig(**config)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/sync/register", response_model=SyncConfig)
def sync_register(payload: SyncLoginRequest):
    try:
        config = register_sync_server(payload.server_url, payload.username, payload.password)
        return SyncConfig(**config)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/sync/logout", response_model=SyncConfig)
def sync_logout():
    return SyncConfig(**logout_sync_server())


@app.post("/partner/request")
def partner_request(payload: PartnerRequestPayload):
    username = str(payload.partner_username or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="partner username required")
    try:
        return create_partner_request(username)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/partner/requests/{request_id}/accept")
def partner_request_accept(request_id: int):
    try:
        return accept_partner_request(request_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/sync/run")
def sync_run(payload: SyncRunRequest):
    future = schedule_sync(payload.direction)
    try:
        return future.result(timeout=0.2)
    except FutureTimeoutError:
        return {"ok": True, "state": "running"}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/sync/pull")
def sync_pull():
    try:
        return pull_remote_changes()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/sync/conflicts")
def sync_conflicts():
    return get_sync_conflicts()


@app.post("/sync/conflicts/resolve")
def sync_conflicts_resolve(payload: SyncConflictResolveRequest):
    try:
        return resolve_sync_conflict(payload.type, payload.uuid, payload.strategy)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/debug/clear-db")
def debug_clear_db():
    clear_db()
    return {"ok": True}


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

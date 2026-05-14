from __future__ import annotations

from pydantic import BaseModel, Field


class CropRect(BaseModel):
    x: float
    y: float
    width: float
    height: float


class ViewportSize(BaseModel):
    width: float
    height: float


class OcrRecognizeRequest(BaseModel):
    image_base64: str = Field(..., description="PNG/JPEG image as base64 data")
    languages: list[str] = Field(default_factory=lambda: ["ja", "zh"])
    # PaddleOCR 3.x recognizer lang (e.g. "ch", "japan", "en"); empty falls back
    # to the sidecar default. Use this when the caller has already split the
    # image by script region (e.g. zh on the bottom, ja on top).
    lang: str = ""
    crop_rect: CropRect | None = None
    viewport: ViewportSize | None = None


class OcrBlock(BaseModel):
    text: str
    score: float


class OcrRecognizeResponse(BaseModel):
    ja_lines: list[str]
    zh_lines: list[str]
    raw_blocks: list[OcrBlock]


class OcrCorrectionSettings(BaseModel):
    enabled: bool = False
    api_key: str = ""
    model: str = "glm-4.7"


class OcrCorrectionSettingsUpdateRequest(BaseModel):
    enabled: bool | None = None
    api_key: str | None = None
    model: str | None = None


class OcrCorrectionRequest(BaseModel):
    ja_lines: list[str] = Field(default_factory=list)
    zh_lines: list[str] = Field(default_factory=list)
    raw_blocks: list[OcrBlock] = Field(default_factory=list)


class OcrCorrectionResponse(BaseModel):
    ja_lines: list[str]
    zh_lines: list[str]
    corrected: bool = False
    skipped_reason: str = ""
    model: str = "glm-4.7"


class PlaybackContextRequest(BaseModel):
    platform: str = "bilibili"
    url: str
    title: str = ""
    current_time: float = 0.0
    duration: float = 0.0
    bvid: str | None = None
    aid: str | None = None
    cid: str | None = None
    ep_id: str | None = None
    p: int | None = None
    part_title: str = ""


class PlaybackContextResponse(BaseModel):
    context_id: str


class JaTokenizeRequest(BaseModel):
    text: str


class JaToken(BaseModel):
    surface: str
    dictionary_form: str
    reading: str = ""
    accent: int | None = None
    pos: str = ""
    jlpt_level: str = ""
    meanings: list[str] = Field(default_factory=list)


class JaTokenizeResponse(BaseModel):
    tokens: list[JaToken]


class VocabPlayback(BaseModel):
    platform: str = "bilibili"
    url: str = ""
    title: str = ""
    current_time: float = 0.0
    duration: float = 0.0
    bvid: str | None = None
    aid: str | None = None
    cid: str | None = None
    ep_id: str | None = None
    p: int | None = None
    part_title: str = ""


class VocabAddItem(BaseModel):
    surface: str = ""
    dictionary_form: str = ""
    reading: str = ""
    jlpt_level: str = ""
    source: str = "manual"
    meanings: list[str] = Field(default_factory=list)
    skip_enrichment: bool = False
    example_ja: str | None = None
    example_zh: str | None = None
    tags: list[str] = Field(default_factory=list)
    screenshot_base64: str | None = None
    playback: VocabPlayback | None = None


class VocabAddItemsRequest(BaseModel):
    items: list[VocabAddItem]


class VocabAddItemsResponse(BaseModel):
    head_ids: list[int]
    created_item_ids: list[int]
    sentence_ids: list[int] = Field(default_factory=list)


class VocabHead(BaseModel):
    id: int
    dictionary_form: str
    created_at: str
    updated_at: str
    item_count: int


class VocabItem(BaseModel):
    id: int
    uuid: str = ""
    head_id: int
    surface: str
    dictionary_form: str = ""
    reading: str
    accent: int | None = None
    jlpt_level: str = ""
    source: str = "manual"
    meanings: list[str]
    example_ja: str
    example_zh: str
    screenshot_path: str | None
    playback: dict | None
    sentence_id: int | None = None
    tags: list[str] = Field(default_factory=list)
    created_at: str


class VocabByPlayerNode(BaseModel):
    platform: str
    source: str = "manual"
    series_name: str
    episode_name: str
    items: list[VocabItem]


class VocabByTimeResponse(BaseModel):
    items: list[VocabItem]


class VocabUpdateItemRequest(BaseModel):
    surface: str | None = None
    dictionary_form: str | None = None
    reading: str | None = None
    jlpt_level: str | None = None
    meanings: list[str] | None = None
    example_ja: str = ""
    example_zh: str = ""
    tags: list[str] | None = None


class SentenceAddRequest(BaseModel):
    example_ja: str = ""
    example_zh: str = ""
    tags: list[str] = Field(default_factory=list)
    source: str = "manual"
    screenshot_base64: str | None = None
    playback: VocabPlayback | None = None


class SentenceUpdateRequest(BaseModel):
    example_ja: str = ""
    example_zh: str = ""
    tags: list[str] | None = None


class SentenceRecord(BaseModel):
    id: int
    uuid: str = ""
    example_ja: str
    example_zh: str = ""
    tags: list[str] = Field(default_factory=list)
    source: str = "manual"
    screenshot_path: str | None = None
    playback: dict | None = None
    word_count: int = 0
    created_at: str
    updated_at: str


class SentenceListResponse(BaseModel):
    items: list[SentenceRecord]
    total: int
    limit: int
    offset: int


class Profile(BaseModel):
    nickname: str = "Drama Learner"
    avatar_data_url: str = ""
    theme_color: str = "#2e8f76"
    signature: str = ""


class SyncConfig(BaseModel):
    server_url: str = ""
    access_token: str = ""
    username: str = ""
    last_sync_at: str = ""
    last_server_version: int = 0
    auto_sync_interval_minutes: int = 0


class SyncConfigUpdateRequest(BaseModel):
    auto_sync_interval_minutes: int = 0


class DesktopSettings(BaseModel):
    notification_window_start: str = "18:00"
    notification_window_end: str = "24:00"


class DesktopSettingsUpdateRequest(BaseModel):
    notification_window_start: str | None = None
    notification_window_end: str | None = None


class AsrSettings(BaseModel):
    hf_mirror_enabled: bool = True


class AsrSettingsUpdateRequest(BaseModel):
    hf_mirror_enabled: bool | None = None


class SyncLoginRequest(BaseModel):
    server_url: str = ""
    username: str
    password: str
    invite_code: str = ""


class SyncRunRequest(BaseModel):
    direction: str = "push_pull"


class ShareSentenceRequest(BaseModel):
    recipient_username: str = ""
    sentence_id: int
    comment: str = ""


class PartnerRequestPayload(BaseModel):
    partner_username: str = ""


class SyncConflictResolveRequest(BaseModel):
    type: str
    uuid: str
    strategy: str


class DictLookupRequest(BaseModel):
    lemma: str


class DictLookupResponse(BaseModel):
    lemma: str
    reading: str = ""
    meanings: list[str] = Field(default_factory=list)
    jlpt_level: str = ""


class AsrTranscribeRequest(BaseModel):
    audio_base64: str = Field(..., description="Audio chunk encoded as base64")
    language: str = "ja"
    with_vad: bool = True


class AsrChunk(BaseModel):
    start: float
    end: float
    text: str


class AsrTranscribeResponse(BaseModel):
    language: str
    duration: float
    text: str
    chunks: list[AsrChunk]


# ---- 百词斩复习 ----


class ReviewStartRequest(BaseModel):
    calendar_day: str = Field(..., description="客户端本地日期 YYYY-MM-DD")
    question_limit: int = 20


class ReviewStartResponse(BaseModel):
    session_id: str = ""
    resumed: bool = False
    calendar_day: str = ""
    cursor: int = 0
    total: int = 0
    current: dict | None = None
    completed: bool = False
    empty_reason: str = ""


class ReviewAnswerRequest(BaseModel):
    session_id: str
    calendar_day: str
    choice_index: int | None = None
    text: str | None = None
    order_piece_ids: list[str] | None = None
    skip: bool = False
    abort: bool = False


class ReviewAnswerResponse(BaseModel):
    done: bool = False
    correct: bool = False
    current: dict | None = None
    hint_reading_after_wrong: bool = False
    reading_stage: str = ""
    head_state: dict = Field(default_factory=dict)
    advanced: bool | None = None
    skipped: bool | None = None
    skipped_question_id: str = ""
    aborted: bool | None = None
    remaining_before_abort: int | None = None


class ReviewSnapshotResponse(BaseModel):
    eligible_heads: int = 0
    mastered_heads: int = 0

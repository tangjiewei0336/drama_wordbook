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
    crop_rect: CropRect | None = None
    viewport: ViewportSize | None = None


class OcrBlock(BaseModel):
    text: str
    score: float


class OcrRecognizeResponse(BaseModel):
    ja_lines: list[str]
    zh_lines: list[str]
    raw_blocks: list[OcrBlock]


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


class PlaybackContextResponse(BaseModel):
    context_id: str


class JaTokenizeRequest(BaseModel):
    text: str


class JaToken(BaseModel):
    surface: str
    dictionary_form: str


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


class VocabAddItem(BaseModel):
    surface: str
    dictionary_form: str
    reading: str = ""
    meanings: list[str] = Field(default_factory=list)
    example_ja: str = ""
    example_zh: str = ""
    screenshot_base64: str | None = None
    playback: VocabPlayback | None = None


class VocabAddItemsRequest(BaseModel):
    items: list[VocabAddItem]


class VocabAddItemsResponse(BaseModel):
    head_ids: list[int]
    created_item_ids: list[int]


class VocabHead(BaseModel):
    id: int
    dictionary_form: str
    created_at: str
    updated_at: str
    item_count: int


class VocabItem(BaseModel):
    id: int
    head_id: int
    surface: str
    reading: str
    meanings: list[str]
    example_ja: str
    example_zh: str
    screenshot_path: str | None
    playback: dict | None
    created_at: str


class VocabByPlayerNode(BaseModel):
    platform: str
    series_name: str
    episode_name: str
    items: list[VocabItem]


class VocabByTimeResponse(BaseModel):
    items: list[VocabItem]


class DictLookupRequest(BaseModel):
    lemma: str


class DictLookupResponse(BaseModel):
    lemma: str
    reading: str = ""
    meanings: list[str] = Field(default_factory=list)

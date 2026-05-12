"""Export local wordbook (vocab + sentences) to Excel (.xlsx)."""

from __future__ import annotations

from io import BytesIO

from app.services.vocab_service import get_all_sentences_flat, get_all_vocab_items


def _playback_columns(pb: dict | None) -> tuple[str, str, str, str, str, str]:
    if not pb:
        return ("", "", "", "", "", "")
    return (
        str(pb.get("platform") or ""),
        str(pb.get("url") or ""),
        str(pb.get("title") or ""),
        str(pb.get("series_name") or ""),
        str(pb.get("episode_name") or ""),
        "" if pb.get("current_time") is None else str(pb.get("current_time")),
    )


def build_wordbook_xlsx_bytes() -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    items = get_all_vocab_items()
    sentences = get_all_sentences_flat()

    wb = Workbook()
    ws_vocab = wb.active
    assert ws_vocab is not None
    ws_vocab.title = "生词"
    ws_sent = wb.create_sheet("句子")

    vocab_headers = [
        "id",
        "词条UUID",
        "词头ID",
        "词头（辞书形）",
        "表记",
        "读音",
        "JLPT",
        "释义（中文）",
        "例句（日）",
        "例句（中）",
        "标签",
        "来源",
        "句子ID",
        "句子UUID",
        "平台",
        "链接",
        "播放页标题",
        "剧集名",
        "分集名",
        "播放时间(s)",
        "截图路径",
        "创建时间",
        "更新时间",
    ]
    ws_vocab.append(vocab_headers)

    for it in items:
        plat, url, title, series, episode, tsec = _playback_columns(it.get("playback"))
        meanings = it.get("meanings") or []
        if isinstance(meanings, list):
            m_str = "；".join(str(x) for x in meanings)
        else:
            m_str = str(meanings)
        tags = it.get("tags") or []
        t_str = "、".join(str(x) for x in tags) if isinstance(tags, list) else str(tags)
        sid = it.get("sentence_id")
        ws_vocab.append(
            [
                it.get("id"),
                it.get("uuid") or "",
                it.get("head_id"),
                it.get("dictionary_form") or "",
                it.get("surface") or "",
                it.get("reading") or "",
                it.get("jlpt_level") or "",
                m_str,
                it.get("example_ja") or "",
                it.get("example_zh") or "",
                t_str,
                it.get("source") or "",
                sid if sid is not None else "",
                it.get("sentence_uuid") or "",
                plat,
                url,
                title,
                series,
                episode,
                tsec,
                it.get("screenshot_path") or "",
                it.get("created_at") or "",
                it.get("updated_at") or "",
            ]
        )

    sent_headers = [
        "id",
        "句子UUID",
        "日文",
        "中文",
        "标签",
        "关联词数",
        "来源",
        "平台",
        "链接",
        "播放页标题",
        "剧集名",
        "分集名",
        "播放时间(s)",
        "截图路径",
        "创建时间",
        "更新时间",
    ]
    ws_sent.append(sent_headers)

    for s in sentences:
        plat, url, title, series, episode, tsec = _playback_columns(s.get("playback"))
        tags = s.get("tags") or []
        t_str = "、".join(str(x) for x in tags) if isinstance(tags, list) else str(tags)
        ws_sent.append(
            [
                s.get("id"),
                s.get("uuid") or "",
                s.get("example_ja") or "",
                s.get("example_zh") or "",
                t_str,
                s.get("word_count"),
                s.get("source") or "",
                plat,
                url,
                title,
                series,
                episode,
                tsec,
                s.get("screenshot_path") or "",
                s.get("created_at") or "",
                s.get("updated_at") or "",
            ]
        )

    bold = Font(bold=True)
    for cell in ws_vocab[1]:
        cell.font = bold
    for cell in ws_sent[1]:
        cell.font = bold

    bio = BytesIO()
    wb.save(bio)
    return bio.getvalue()

from __future__ import annotations

import json
import re
from urllib import error as urlerror
from urllib import request as urlrequest


GLM_CHAT_COMPLETIONS_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"


def _clean_lines(values: list[str] | tuple[str, ...] | None) -> list[str]:
    if not values:
        return []
    out: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text:
            out.append(text)
    return out[:6]


def _extract_json_object(text: str) -> dict:
    source = str(text or "").strip()
    if source.startswith("```"):
        source = re.sub(r"^```(?:json)?\s*", "", source)
        source = re.sub(r"\s*```$", "", source)
    try:
        parsed = json.loads(source)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", source, flags=re.S)
        if not match:
            return {}
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}


def _llm_prompt(ja_lines: list[str], zh_lines: list[str], raw_texts: list[str]) -> str:
    payload = {
        "ja_lines": ja_lines,
        "zh_lines": zh_lines,
        "raw_blocks": raw_texts[:12],
    }
    return (
        "请修正日剧字幕 OCR 结果。你会收到日语行、中文行和原始 OCR 块。\n"
        "目标：只保留真实字幕，去掉背景/水印/乱码；修正日语促音っ/ッ误识别为つ/ツ的问题；"
        "修正中日语错位，把中文翻译放入 zh_lines，把日语原文放入 ja_lines。\n"
        "约束：不要翻译、不要补写没有出现的内容，不确定就保留原文；输出必须是 JSON，"
        "格式为 {\"ja_lines\":[\"...\"],\"zh_lines\":[\"...\"]}。\n"
        f"OCR_RESULT={json.dumps(payload, ensure_ascii=False)}"
    )


def correct_ocr_lines_with_glm(
    *,
    ja_lines: list[str],
    zh_lines: list[str],
    raw_blocks: list[dict],
    api_key: str,
    model: str = "glm-4.7",
    timeout_seconds: float = 18.0,
) -> dict:
    clean_ja = _clean_lines(ja_lines)
    clean_zh = _clean_lines(zh_lines)
    raw_texts = _clean_lines([str(x.get("text") or "") for x in raw_blocks if isinstance(x, dict)])
    key = str(api_key or "").strip()
    use_model = str(model or "glm-4.7").strip() or "glm-4.7"
    if not key:
        return {"ja_lines": clean_ja, "zh_lines": clean_zh, "corrected": False, "skipped_reason": "missing_api_key", "model": use_model}
    if not clean_ja and not clean_zh and not raw_texts:
        return {"ja_lines": [], "zh_lines": [], "corrected": False, "skipped_reason": "empty_input", "model": use_model}

    body = {
        "model": use_model,
        "messages": [
            {
                "role": "system",
                "content": "你是严谨的中日双语字幕 OCR 后处理器，只输出 JSON，不添加解释。",
            },
            {"role": "user", "content": _llm_prompt(clean_ja, clean_zh, raw_texts)},
        ],
        "temperature": 0.1,
        "stream": False,
        "max_tokens": 800,
    }
    req = urlrequest.Request(
        GLM_CHAT_COMPLETIONS_URL,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=timeout_seconds) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urlerror.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:240]
        raise RuntimeError(f"GLM OCR 修正失败（HTTP {exc.code}）：{detail}") from exc
    except Exception as exc:
        raise RuntimeError(f"GLM OCR 修正失败：{exc}") from exc

    content = ""
    try:
        content = str(data["choices"][0]["message"]["content"] or "")
    except Exception:
        content = ""
    parsed = _extract_json_object(content)
    next_ja = _clean_lines(parsed.get("ja_lines") if isinstance(parsed.get("ja_lines"), list) else clean_ja)
    next_zh = _clean_lines(parsed.get("zh_lines") if isinstance(parsed.get("zh_lines"), list) else clean_zh)
    if not next_ja and clean_ja:
        next_ja = clean_ja
    if not next_zh and clean_zh:
        next_zh = clean_zh
    return {
        "ja_lines": next_ja,
        "zh_lines": next_zh,
        "corrected": True,
        "skipped_reason": "",
        "model": use_model,
    }

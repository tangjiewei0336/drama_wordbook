# Sidecar 启动说明

## 1. 安装依赖

在 `apps/sidecar` 目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -U pip
pip install -e .
```

## 2. 启动服务

```bash
uvicorn app.main:app --host 127.0.0.1 --port 17321 --reload
```

默认不会在启动时下载 ASR 模型；第一次点击插件里的「开始语音识别」时才会按需加载 `faster-whisper` 模型。OCR 模型会在桌面端启动时后台预热，运行中心可手动下载/修复。若希望启动时提前加载 ASR，可显式开启：

```bash
ASR_PRELOAD=1 uvicorn app.main:app --host 127.0.0.1 --port 17321 --reload
```

如果 Hugging Face 下载不稳定，可以指定镜像或本地缓存目录：

```bash
ASR_HF_ENDPOINT=https://hf-mirror.com ASR_MODEL_DOWNLOAD_ROOT=.models uvicorn app.main:app --host 127.0.0.1 --port 17321 --reload
```

桌面端的设置 -> 运行中心也提供 hf-mirror 开关。OCR 默认会设置 PaddleX 相关缓存目录，Windows 打包场景会尽量避开中文用户目录导致的模型加载问题。

## 3. 检查服务

打开浏览器访问：

- `http://127.0.0.1:17321/health`
- `http://127.0.0.1:17321/docs`

## 4. 主要接口

- `GET /health`
- `POST /ocr/recognize`
- `GET /ocr/status`
- `POST /ocr/model/load`
- `POST /ocr/model/repair`
- `GET/PATCH /ocr/correction/settings`
- `POST /ocr/correct`
- `POST /ja/tokenize`
- `POST /ja/analyze`
- `POST /dict/lookup`
- `POST /playback/context`
- `POST /vocab/add_items`
- `GET /vocab/view/by-player`
- `GET /vocab/view/by-time`
- `GET/POST/PATCH/DELETE /sentences`
- `POST /asr/transcribe`
- `GET /asr/status`
- `POST /asr/model/load`
- `GET/PATCH /asr/settings`
- `POST /review/start`
- `GET /review/current`
- `POST /review/answer`
- `GET /review/snapshot`
- `GET /export/wordbook.xlsx`
- `GET /export/wordbook.pdf`

## 5. OCR 大模型修正

`/ocr/correct` 会读取本地 `ocr_correction_settings`。启用并填写 API Key 后，sidecar 会调用智谱 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，默认模型 `glm-4.7`，也支持 `glm-4.7-flashx`。请求体不传 `thinking` / `reasoning` 字段。

该功能用于修正：

- 日语促音 `っ/ッ` 与 `つ/ツ` 误识别
- 中日语字幕错位
- 背景文字、台标、水印等被 OCR 成乱码

没有启用或没有 API Key 时，接口会返回原始中日语行并标记 `corrected=false`。

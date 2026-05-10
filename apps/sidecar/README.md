# Sidecar POC 启动说明

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

默认不会在启动时下载 ASR 模型；第一次点击插件里的「开始语音识别」时才会按需加载 `faster-whisper` 模型。若希望启动时提前加载，可显式开启：

```bash
ASR_PRELOAD=1 uvicorn app.main:app --host 127.0.0.1 --port 17321 --reload
```

如果 Hugging Face 下载不稳定，可以指定镜像或本地缓存目录：

```bash
ASR_HF_ENDPOINT=https://hf-mirror.com ASR_MODEL_DOWNLOAD_ROOT=.models uvicorn app.main:app --host 127.0.0.1 --port 17321 --reload
```

## 3. 检查服务

打开浏览器访问：

- `http://127.0.0.1:17321/health`
- `http://127.0.0.1:17321/docs`

## 4. 目前接口

- `GET /health`
- `POST /ocr/recognize`
- `POST /ja/tokenize`
- `POST /playback/context`
- `GET /playback/context/{context_id}`
- `POST /asr/transcribe`

> 说明：这是试验版本。`/playback/context` 当前是内存存储，重启后会清空。

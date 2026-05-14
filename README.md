# UNI / Drama Wordbook

UNI is a desktop wordbook for Japanese drama and anime learners. While watching Bilibili, the Chrome extension can capture the current video frame, OCR the subtitles, optionally clean the OCR with GLM, tokenize the Japanese sentence, look up dictionary meanings, and save words with the original screenshot and playback timestamp.

## What It Does

- Bilibili extension: screenshot OCR, fixed bilingual subtitle layout, subtitle-band cropping, editable OCR text, retokenization after edits, and in-page word selection.
- Local sidecar: FastAPI service for OCR, GLM OCR correction, Japanese tokenization, dictionary lookup, pitch accent, ASR, review, export, and SQLite storage.
- Desktop app: Electron + React UI for browsing by drama/episode, date, and sentence; review drills; exports; sync; settings; runtime logs.
- Review mode: multiple-choice, reading input, sentence ordering, skip/abort, max 7 sentence-order chunks, completion stats and animation.
- Export: PDF and Excel wordbook export with date-range filters.
- Runtime settings: OCR/ASR model download and repair, hf-mirror toggle, logs with pause auto-scroll.

## Repository Layout

```text
apps/
  desktop/       Electron + React desktop app
  sidecar/       Python FastAPI sidecar
  server/        Optional sync server
extensions/
  bilibili/      Chrome/Edge extension for Bilibili
docs/            Chinese user/developer docs
```

## Quick Start

### 1. Start the sidecar

```bash
cd apps/sidecar
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -U pip
pip install -e .
uvicorn app.main:app --host 127.0.0.1 --port 17321 --reload
```

Check `http://127.0.0.1:17321/health`.

### 2. Start the desktop app

```bash
cd apps/desktop
npm install
npm run dev
```

The Vite dev server uses `http://127.0.0.1:4173` with `--strictPort`.

### 3. Load the extension

1. Open `chrome://extensions/`.
2. Enable Developer Mode.
3. Load unpacked extension from `extensions/bilibili`.
4. Open a Bilibili video and trigger manual screenshot recognition from the extension popup or the page shortcut.

## OCR Correction With GLM

In desktop Settings -> OCR 修正, enable GLM post-processing and enter a Zhipu API key. Supported models:

- `GLM-4.7`
- `GLM-4.7-FlashX`

The extension sends the original Japanese lines, Chinese lines, and raw OCR blocks to `/ocr/correct` after `/ocr/recognize`. The sidecar asks GLM to remove background garbage, fix Japanese small-tsu issues, and correct Chinese/Japanese line swaps. Thinking mode is not enabled in the request body.

Automatic subtitle capture does not call GLM correction. It only uses local OCR cleanup and tokenization so background capture cannot block on a network model request.

## Packaging

Build the sidecar on the target OS first:

```bash
cd apps/sidecar
source .venv/bin/activate
pip install -e ".[packaging]"
pyinstaller sidecar.spec
```

Then package the desktop app:

```bash
cd apps/desktop
npm run dist:mac
npm run dist:win
```

The packaged desktop app stores sidecar data in a user-writable directory. On Windows, it avoids non-ASCII user-home paths for Paddle model caches when needed.

## Useful Docs

- [快速启动教程](docs/快速启动教程.md)
- [完整功能介绍](docs/完整功能介绍.md)
- [端口与功能说明](docs/端口与功能说明.md)
- [Bilibili extension README](extensions/bilibili/README.md)
- [Desktop README](apps/desktop/README.md)
- [Sidecar README](apps/sidecar/README.md)

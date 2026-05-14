# UNI Desktop

Electron + React desktop shell for browsing, reviewing, exporting, and syncing vocabulary saved by the local sidecar.

## Requirements

- Node.js 20+
- Sidecar running at `http://127.0.0.1:17321` for live data
- Desktop dev server uses the fixed port `http://127.0.0.1:4173`

The app can start without sidecar; it will show an offline state and empty data.

## Development

```bash
cd apps/desktop
npm install
npm run dev
```

This starts Vite and opens the Electron window.
Both `npm run dev` and `npm run dev:web` use `--strictPort`; if port `4173` is occupied, stop the old process first.

For browser-only UI development:

```bash
npm run dev:web
```

## Production Start

```bash
npm run build
npm start
```

`npm start` loads the built `dist` assets in Electron.

## Packaging

For distribution, build the Python sidecar into a native executable first. Do this on each target OS because PyInstaller does not cross-compile:

```bash
cd ../sidecar
source .venv/bin/activate
pip install -e ".[packaging]"
pyinstaller sidecar.spec
```

Then build the desktop package:

```bash
cd ../desktop
npm run dist:mac
npm run dist:win
```

`electron-builder` copies `apps/sidecar/dist/drama-wordbook-sidecar/` (PyInstaller **onedir** output, including `_internal/`) into the app `Resources/sidecar/`. End users do not need Python, pip, or a virtualenv.

Generated desktop artifacts are written to `apps/desktop/release`.

## Current Features

- Browse vocabulary by player source, by time, and by sentence.
- View sentence screenshots, edit sentence text, analyze tokens, click words for dictionary lookup, share sentences, and delete a sentence with its bound words.
- Use Space to see activity, partner activity, recent series, partner requests, and shared sentences.
- Review with multiple-choice, reading input, and sentence-order questions; skip bad questions, abort a round, and see completion stats.
- Export the wordbook to PDF or Excel, with date-range filters. PDF groups entries by drama/episode and includes readings, pitch accents, parts of speech, example sentences, and screenshots.
- Open Settings as a sidebar-driven panel with pages for profile, export, OCR correction, sync, desktop reminders, and runtime.
- Configure OCR GLM correction from Settings -> OCR 修正. Supported models are `GLM-4.7` and `GLM-4.7-FlashX`.
- Log in to sync, edit profile after login, configure auto-sync interval, and resolve sync conflicts.
- Inspect Sidecar health, OCR/ASR model status, repair buttons, hf-mirror download setting, and logs from Settings -> 运行中心.

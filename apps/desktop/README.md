# Drama Wordbook Desktop

Electron + React desktop shell for browsing vocabulary saved by the local sidecar.

## Requirements

- Node.js 20+
- Sidecar running at `http://127.0.0.1:17321` for live data

The app can start without sidecar; it will show an offline state and empty data.

## Development

```bash
cd apps/desktop
npm install
npm run dev
```

This starts Vite and opens the Electron window.

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

`electron-builder` copies `apps/sidecar/dist/drama-wordbook-sidecar*` into the app resources. End users do not need Python, pip, or a virtualenv.

Generated desktop artifacts are written to `apps/desktop/release`.

# PyInstaller spec for the packaged local sidecar.
#
# Build on each target OS:
#   pyinstaller sidecar.spec
#
# The output executable is copied into the Electron app through
# apps/desktop/package.json extraResources.

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

hiddenimports = []
hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("fastapi")
hiddenimports += collect_submodules("pydantic")
hiddenimports += collect_submodules("sudachipy")
hiddenimports += collect_submodules("pyopenjtalk")
# PaddleOCR 2.x + OpenCV / geometry helpers (often dynamic imports in frozen builds).
for _ocr_hid in ("cv2", "yaml", "shapely", "shapely.geometry", "pyclipper", "skimage", "skimage.morphology"):
    hiddenimports.append(_ocr_hid)

datas = []
datas += collect_data_files("sudachidict_core")
datas += collect_data_files("pyopenjtalk")
# PaddleOCR package data / models metadata for frozen builds (2.x PP-OCR).
datas += collect_data_files("paddleocr")
datas += [("app/data/jlpt/all.csv", "app/data/jlpt")]

a = Analysis(
    ["sidecar_launcher.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# Onedir (not --onefile): single-process layout is more reliable when Electron
# spawns the binary (fewer bootloader/signal quirks than onefile on macOS).
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="drama-wordbook-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="drama-wordbook-sidecar",
)

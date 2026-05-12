# PyInstaller spec for the packaged local sidecar.
#
# Build on each target OS:
#   pyinstaller sidecar.spec
#
# The output executable is copied into the Electron app through
# apps/desktop/package.json extraResources.

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

block_cipher = None


def _safe_collect_submodules(name: str) -> list[str]:
    try:
        return collect_submodules(name)
    except Exception:
        return []


def _safe_collect_data_files(name: str, **kw) -> list:
    try:
        return collect_data_files(name, **kw)
    except Exception:
        return []


def _safe_collect_dynamic_libs(name: str) -> list:
    try:
        return collect_dynamic_libs(name)
    except Exception:
        return []


hiddenimports: list[str] = []
hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("fastapi")
hiddenimports += collect_submodules("pydantic")
hiddenimports += collect_submodules("sudachipy")
hiddenimports += collect_submodules("pyopenjtalk")
# PaddleOCR 2.x has many lazy/dynamic imports (ppocr/data, ppocr/postprocess,
# ppocr/modeling, tools/infer, etc.); collect the whole package or runtime
# registration (det/rec/cls algorithms) will fail in a frozen build.
hiddenimports += _safe_collect_submodules("paddleocr")
# PaddlePaddle itself: native ops live under paddle._C and many lazy modules.
# Without collect_submodules("paddle") the C++ extension loader breaks at import.
hiddenimports += _safe_collect_submodules("paddle")
# paddle.utils.cpp_extension reads Cython/Utility/*.cpp templates at import time
# (or via inline op build). PyInstaller would otherwise ship Cython as bytecode
# only and miss these non-Python resource files.
hiddenimports += _safe_collect_submodules("Cython")
# Helper libs paddleocr/paddle pull in dynamically; keep explicit so a missing
# wheel surfaces during build instead of at runtime.
for _ocr_hid in (
    "cv2",
    "yaml",
    "shapely",
    "shapely.geometry",
    "pyclipper",
    "skimage",
    "skimage.morphology",
    "scipy",
    "scipy.sparse",
    "scipy.special",
    "lmdb",
    "imghdr",
    "Levenshtein",
    "premailer",
    "lxml",
    "lxml.etree",
    "pkg_resources.py2_warn",
):
    hiddenimports.append(_ocr_hid)

datas: list = []
datas += collect_data_files("sudachidict_core")
datas += collect_data_files("pyopenjtalk")
# PaddleOCR package data / models metadata for frozen builds (2.x PP-OCR).
# include_py_files=True ships .py for dynamically imported algo registries.
datas += _safe_collect_data_files("paddleocr", include_py_files=True)
# Paddle ships proto/.so descriptors + version.py needed at runtime.
datas += _safe_collect_data_files("paddle", include_py_files=False)
datas += _safe_collect_data_files("shapely")
datas += _safe_collect_data_files("skimage")
# Cython ships .cpp/.pyx templates under Cython/Utility/ and Cython/Includes/;
# paddle (and some image libs) read them via importlib.resources at runtime,
# so we must bundle them as data even though Cython itself is mostly .py.
datas += _safe_collect_data_files("Cython", include_py_files=True)
datas += [("app/data/jlpt/all.csv", "app/data/jlpt")]

# Native libs: paddlepaddle ships libpaddle.* / libgomp / libdnnl, opencv ships
# libopencv_*. Without these the import errors with `paddle._C` or
# `_cv2` cannot be loaded.
binaries: list = []
binaries += _safe_collect_dynamic_libs("paddle")
binaries += _safe_collect_dynamic_libs("paddleocr")
binaries += _safe_collect_dynamic_libs("cv2")

a = Analysis(
    ["sidecar_launcher.py"],
    pathex=[],
    binaries=binaries,
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

# PyInstaller spec for the packaged local sidecar.
#
# Build on each target OS:
#   pyinstaller sidecar.spec
#
# The output executable is copied into the Electron app through
# apps/desktop/package.json extraResources.

import importlib.util
from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

block_cipher = None


def _safe_collect_submodules(name: str, **kw) -> list[str]:
    try:
        return collect_submodules(name, **kw)
    except Exception:
        return []


def _safe_collect_data_files(name: str, **kw) -> list:
    spec = importlib.util.find_spec(name)
    if spec is None or spec.submodule_search_locations is None:
        return []
    try:
        return collect_data_files(name, **kw)
    except Exception:
        return []


def _safe_collect_dynamic_libs(name: str) -> list:
    try:
        return collect_dynamic_libs(name)
    except Exception:
        return []


def _safe_copy_metadata(name: str) -> list:
    try:
        return copy_metadata(name)
    except Exception:
        return []


def _collect_pyopenjtalk_data() -> list:
    """Collect OpenJTalk dictionary/voice resources and fail builds if missing.

    pyopenjtalk resolves its dictionary via importlib.resources at runtime. In a
    frozen onedir app that path becomes `_internal/pyopenjtalk/...`; if the
    dictionary directory is not bundled, every pitch-accent lookup emits
    `Mecab_load() ... Cannot open ... open_jtalk_dic_utf_8-1.11`.
    """
    spec = importlib.util.find_spec("pyopenjtalk")
    if spec is None or not spec.origin:
        return []
    try:
        import pyopenjtalk

        # Some build environments download/extract the dictionary lazily. Force
        # that to happen during packaging so the artifact is self-contained.
        lazy_init = getattr(pyopenjtalk, "_lazy_init", None)
        if callable(lazy_init):
            lazy_init()
    except Exception as exc:
        raise RuntimeError(f"pyopenjtalk is installed but its dictionary cannot be prepared: {exc}") from exc

    package_dir = Path(spec.origin).resolve().parent
    dic_dir = package_dir / "open_jtalk_dic_utf_8-1.11"
    voice_dir = package_dir / "htsvoice"
    if not (dic_dir / "sys.dic").exists():
        raise RuntimeError(f"pyopenjtalk dictionary is missing: {dic_dir}")

    items = _safe_collect_data_files("pyopenjtalk")
    seen = set(items)
    for root in (dic_dir, voice_dir):
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            dest = str(Path("pyopenjtalk") / path.parent.relative_to(package_dir))
            item = (str(path), dest)
            if item not in seen:
                items.append(item)
                seen.add(item)
    return items


def _module_exists(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


hiddenimports: list[str] = []
hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("fastapi")
hiddenimports += collect_submodules("pydantic")
hiddenimports += collect_submodules("sudachipy")
hiddenimports += collect_submodules("pyopenjtalk")
# PaddleOCR 3.x routes through PaddleX pipelines (paddlex.inference.pipelines
# .ocr) for predict(); these submodules are discovered dynamically by config.
hiddenimports += _safe_collect_submodules(
    "paddleocr",
    filter=lambda name: not name.startswith("paddleocr._doc2md"),
)
hiddenimports += _safe_collect_submodules(
    "paddlex",
    filter=lambda name: not (
        name.startswith("paddlex.inference.serving")
        or name.startswith("paddlex.inference.servers")
    ),
)
# PaddlePaddle itself: native ops live under paddle._C and many lazy modules.
# Without collect_submodules("paddle") the C++ extension loader breaks at import.
hiddenimports += _safe_collect_submodules(
    "paddle",
    filter=lambda name: not name.startswith("paddle.tensorrt"),
)
# paddle.utils.cpp_extension reads Cython/Utility/*.cpp templates at import time
# (or via inline op build). PyInstaller would otherwise ship Cython as bytecode
# only and miss these non-Python resource files.
hiddenimports += _safe_collect_submodules("Cython")
# openpyxl/reportlab: /export/wordbook.xlsx + /export/wordbook.pdf; collect lazy
# submodules in frozen builds.
hiddenimports += _safe_collect_submodules("openpyxl")
hiddenimports += _safe_collect_submodules("reportlab")
# Helper libs paddleocr/paddle pull in dynamically; keep explicit so a missing
# wheel surfaces during build instead of at runtime.
for _ocr_hid in (
    "cv2",
    "bidi",
    "imagesize",
    "yaml",
    "shapely",
    "shapely.geometry",
    "pyclipper",
    "pypdfium2",
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
    if _module_exists(_ocr_hid):
        hiddenimports.append(_ocr_hid)

datas: list = []
datas += collect_data_files("sudachidict_core")
datas += _collect_pyopenjtalk_data()
# PaddleOCR + PaddleX 3.x package YAML/JSON pipeline configs and the
# multilingual recognizer dictionaries; without these the pipeline init
# raises "The pipeline (OCR) does not exist!".
# include_py_files=True ships .py for dynamically imported algo registries.
datas += _safe_collect_data_files("paddleocr", include_py_files=True)
datas += _safe_collect_data_files("paddlex", include_py_files=True)
# Paddle ships proto/.so descriptors + version.py needed at runtime.
datas += _safe_collect_data_files("paddle", include_py_files=False)
datas += _safe_collect_data_files("bidi")
datas += _safe_collect_data_files("imagesize")
datas += _safe_collect_data_files("pypdfium2")
datas += _safe_collect_data_files("shapely")
datas += _safe_collect_data_files("skimage")
# Cython ships .cpp/.pyx templates under Cython/Utility/ and Cython/Includes/;
# paddle (and some image libs) read them via importlib.resources at runtime,
# so we must bundle them as data even though Cython itself is mostly .py.
datas += _safe_collect_data_files("Cython", include_py_files=True)
datas += _safe_collect_data_files("reportlab", include_py_files=True)
datas += _safe_collect_data_files("faster_whisper", include_py_files=True)
# PaddleX checks extras with importlib.metadata at runtime. In frozen builds,
# these *.dist-info directories are not guaranteed to be present unless copied
# explicitly; without them, paddlex.utils.deps reports that `OCR` dependencies
# are missing even when the modules themselves were bundled.
for _metadata_dist in (
    "paddlex",
    "paddleocr",
    "paddlepaddle",
    "imagesize",
    "opencv-contrib-python",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
    "faster-whisper",
):
    datas += _safe_copy_metadata(_metadata_dist)
datas += [("app/data/jlpt/all.csv", "app/data/jlpt")]

# Native libs: paddlepaddle ships libpaddle.* / libgomp / libdnnl, paddlex
# bundles a few helper sos, opencv ships libopencv_*. Without these the
# import errors with `paddle._C` or `_cv2` cannot be loaded.
binaries: list = []
binaries += _safe_collect_dynamic_libs("paddle")
binaries += _safe_collect_dynamic_libs("paddleocr")
binaries += _safe_collect_dynamic_libs("paddlex")
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

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

datas = []
datas += collect_data_files("sudachidict_core")
datas += collect_data_files("pyopenjtalk")
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

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="drama-wordbook-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

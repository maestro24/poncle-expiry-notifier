# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import collect_all

datas = [('frontend', 'frontend'), ('assets', 'assets')]
binaries = []
hiddenimports = ['clr_loader']
hiddenimports += collect_submodules('apscheduler')
tmp_ret = collect_all('webview')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('pystray')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# windows_toasts/winsdk are NOT used by app code, but collect_all('winsdk') ships
# runtime DLLs (winrt\\MSVCP140.dll etc.) that the GitHub-Actions setup-python
# build of python312.dll needs to load on client Windows. Removing them made the
# CI-built exe crash with "Failed to load Python DLL" (v1.2.6). Keep them bundled.
tmp_ret = collect_all('windows_toasts')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('winsdk')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

# Drop OS "API set" forwarder stubs (api-ms-win-core-*.dll) that leak in from the
# build host. On a GitHub Windows Server runner these exist as physical files and
# get bundled; on the user's client Windows they shadow the native API set schema
# and make python312.dll fail to load ("Failed to load Python DLL ... the specified
# module could not be found"). Excluding them lets the target OS resolve the API
# sets natively (matching a working local python.org build). Keep api-ms-win-crt-*
# (the Universal CRT), which is meant to ship.
a.binaries = [b for b in a.binaries if not b[0].lower().startswith("api-ms-win-core")]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='약정만료 알리미',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['assets\\icon.ico'],
)

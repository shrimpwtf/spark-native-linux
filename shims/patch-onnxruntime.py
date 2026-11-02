#!/usr/bin/env python3
"""Point onnxruntime.dll's dynamic dxcore.dll load at sprkdx.dll.

Wine's dxcore answers no to every adapter capability, so ONNX Runtime finds no
DirectML device and Spark turns off its AI Assistant. shims/dxcore-shim.c corrects
the answers. See docs/investigation.md. The name has the same length, so the DLL
layout does not change, and patching the name back restores the original.
"""
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get('SPARK_ROOT') or Path(__file__).resolve().parents[1])
TARGET = ROOT / ('app/resources/app.asar.unpacked/node_modules/@readdle'
                 '/sparkcore-win/bin/Release/SparkCore.bundle/onnxruntime.dll')
OLD = 'dxcore.dll\0'.encode('utf-16le')
NEW = 'sprkdx.dll\0'.encode('utf-16le')

assert len(OLD) == len(NEW), 'library names must be the same length'

if not TARGET.exists():
    sys.exit('error: %s not found. Extract the installer into app/ first.' % TARGET)

data = TARGET.read_bytes()
count = data.count(OLD)
if count == 0 and data.count(NEW) == 1:
    print('Already patched; nothing to do.')
    raise SystemExit(0)
if count != 1:
    sys.exit('error: expected exactly one dxcore.dll load name, found %d' % count)

# Replace the file instead of writing in place: a running backend has it mapped.
temporary = TARGET.with_name(TARGET.name + '.new')
temporary.write_bytes(data.replace(OLD, NEW, 1))
os.replace(temporary, TARGET)
print('Redirected onnxruntime dxcore.dll load to sprkdx.dll')

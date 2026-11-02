# Native mode (experimental)

Spark's UI runs in a native Linux Electron. Only the Windows backend runs in Wine.
Nothing in Spark's `app.asar` is modified: the shim hooks module loading and
`utilityProcess.fork` at run time, so an update needs no re-patching.

## How it works

- `shim.js` is preloaded with `electron -r`. It reports `win32` to code inside
  `app.asar`, sets the Windows data-path variables, replaces
  `@readdle/sparkcore-win` and `electron-clipboard-ex` with stubs, and starts the
  sparkcore worker inside Wine.
- `wine-host.js` runs under Spark's own Windows Electron in node mode
  (`ELECTRON_RUN_AS_NODE=1`). It fakes `process.parentPort` and transferable
  ports, then loads the worker straight from the patched `app.asar`.
- `frames.js` carries both over one loopback TCP connection as v8-serialized
  frames. Ports are relayed by id, so the worker's `MessagePort` traffic works
  unchanged.
- `addon-stub.js` stands in for the addon in the main process. Calls it cannot
  answer yet return inert stubs and are logged to `SPARK_STUB_LOG`.

## Run

Needs a Linux Electron with the same version as Spark's bundled one. The setup
script downloads it, verifies its checksum, and runs the compatibility check. It
also builds `sprkdx.dll` and patches `onnxruntime.dll` so the AI Assistant can find
the GPU. `run-native.sh` copies that DLL into this mode's prefix on every start.

```bash
./native/setup-electron.sh
./native/run-native.sh
```

`./install-handler.sh` adds "Spark Mail (Native)" to the app menu.

This mode keeps everything in `native-state/`, including its own Wine prefix, so
you sign in separately from the Wine mode. Set `SPARK_NATIVE_STATE` to use another
directory. The worker opens the databases of whichever prefix it runs in, and the
shim refuses the live `prefix/` unless `SPARK_NATIVE_USE_LIVE_PREFIX=1`.

Proton Mail Bridge needs its local certificate trusted once. Start this mode at
least once and keep Bridge running, then run `native/trust-proton-bridge.py`. It
changes only this mode's prefix.

While this mode runs, `bin/auth-callback.py` sends sign-in callbacks and Spark
links to it. Otherwise they go to the Wine mode, even if you normally use this one.

`SPARK_NATIVE_SNAPSHOT=dir` writes a PNG of each Spark window after
`SPARK_NATIVE_SNAPSHOT_DELAY_MS` (default 15000).

## After a Spark update

1. Run `setup-electron.sh`. Its compatibility check fails when the worker entry, the
   bridged APIs or the bundled Electron version change, and it reapplies the
   `onnxruntime.dll` patch.
2. Run once and read `tmp/addon-stub.log`. `NEW addon member:` lines mark addon
   functions the stubs do not know yet.

## Not done

Real backends for the remaining stubbed main-process addon calls (purchases,
updates, previews, print, transcription), translating every Windows path in worker
replies (only `shell` calls and icons are mapped), the Spark CLI pipe, and sharing
the existing prefix state. Clicking a notification does nothing: they come from the
`bin/mail-notify.py` watcher, because Spark's core raised no notification events
here. The backend log, `native-state/logs/wine-worker.log`, records raw mail headers,
so keep it private.

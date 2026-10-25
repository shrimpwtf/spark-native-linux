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

Needs a Linux Electron with the same version as Spark's bundled one. Use a test
prefix: the worker opens the databases of whichever prefix it runs in, and the
shim refuses the live `prefix/` unless `SPARK_NATIVE_USE_LIVE_PREFIX=1`.

```bash
ELECTRON_RUN_AS_NODE=1 "$SPARK_ELECTRON" native/check-compat.js app
SPARK_PREFIX=/path/to/test-prefix SPARK_ELECTRON=/path/to/electron ./native/run-native.sh
```

`SPARK_NATIVE_SNAPSHOT=dir` writes a PNG of each Spark window after
`SPARK_NATIVE_SNAPSHOT_DELAY_MS` (default 15000).

## After a Spark update

1. Run `check-compat.js`. It fails when the worker entry, the bridged APIs or the
   bundled Electron version change.
2. Run once and read `tmp/addon-stub.log`. `NEW addon member:` lines mark addon
   functions the stubs do not know yet.

## Not done

Real backends for the stubbed main-process addon calls (notifications, auth,
purchases, updates, URL parsing beyond `mailto:`, previews, print, transcription),
translating Windows paths in worker replies, tray and protocol-handler
registration on Linux, the Spark CLI pipe, and sharing the existing prefix state.

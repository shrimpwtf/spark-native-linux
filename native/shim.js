'use strict';
// Preload for native Linux Electron: electron -r native/shim.js app.asar
//
// It never edits Spark's code. It hooks module loading and the utility
// process API so Spark's Windows-only backend runs in Wine instead:
//   - @readdle/sparkcore-win and electron-clipboard-ex are replaced in the
//     main process by stubs.
//   - The sparkcore worker is started inside Wine and bridged over TCP.
const Module = require('module');
const path = require('path');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { writeFrame, readFrames } = require('./frames');

const nativeDir = __dirname;
const root = process.env.SPARK_ROOT || path.resolve(nativeDir, '..');
const prefix = process.env.SPARK_PREFIX || path.join(root, 'prefix');
const appDir = process.env.SPARK_APP || path.join(root, 'app');
if (path.resolve(prefix) === path.join(root, 'prefix') && process.env.SPARK_NATIVE_USE_LIVE_PREFIX !== '1') {
  throw new Error('native mode would open the live Wine prefix; set SPARK_PREFIX to a test prefix or SPARK_NATIVE_USE_LIVE_PREFIX=1');
}
const logDir = process.env.SPARK_NATIVE_LOG_DIR || path.join(root, 'tmp');
fs.mkdirSync(logDir, { recursive: true });
const log = (msg) => fs.appendFileSync(path.join(logDir, 'native-shim.log'), `${new Date().toISOString()} ${msg}\n`);

const appData = process.env.SPARK_APPDATA || path.join(root, 'tmp', 'native-appdata');
for (const [name, sub] of [['APPDATA', 'Roaming'], ['LOCALAPPDATA', 'Local']]) {
  process.env[name] = process.env[name] || path.join(appData, sub);
  process.env[name.toLowerCase()] = process.env[name];
  fs.mkdirSync(process.env[name], { recursive: true });
}

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '@readdle/sparkcore-win') return require('./addon-stub');
  if (request === 'electron-clipboard-ex') return new Proxy({}, { get: () => () => undefined });
  return originalLoad.apply(this, arguments);
};

const realPlatform = process.platform;
// Spark only branches on win32 and darwin. Report win32 to code inside app.asar
// and keep the real platform for Electron and Node internals.
Object.defineProperty(process, 'platform', {
  configurable: true,
  enumerable: true,
  get() {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 12;
    const stack = new Error().stack;
    Error.stackTraceLimit = limit;
    return stack.includes('app.asar') ? 'win32' : realPlatform;
  },
});

function toWinPath(p) {
  const drive = path.join(prefix, 'drive_c') + path.sep;
  if (p.startsWith(drive)) return 'C:\\' + p.slice(drive.length).replace(/\//g, '\\');
  return 'Z:' + p.replace(/\//g, '\\');
}

function mapPaths(value) {
  if (typeof value === 'string') return value.startsWith('/') ? toWinPath(value) : value;
  if (Array.isArray(value)) return value.map(mapPaths);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapPaths(v)]));
  }
  return value;
}

class WineWorker extends EventEmitter {
  constructor(entry, options) {
    super();
    this.pid = undefined;
    this.sock = null;
    this.pending = [];
    this.relays = new Map();
    this.nextId = 1; // ids created here are odd; the Wine side uses even ids
    this.token = crypto.randomBytes(16).toString('hex');

    const server = net.createServer((sock) => this.accept(sock, server));
    server.listen(0, '127.0.0.1', () => this.spawnWine(entry, options, server.address().port));
  }

  spawnWine(entry, options, bridgePort) {
    const out = fs.openSync(path.join(logDir, 'wine-worker.log'), 'a');
    const env = {
      ...process.env,
      ...(options && options.env),
      ELECTRON_RUN_AS_NODE: '1',
      SPARK_EXE: path.join(appDir, 'Spark Desktop.exe'),
      SPARK_NOTIFY: '0',
      SPARK_CLOSE_TRAY: '0',
      SPARK_IMAGE_BRIDGE: '0',
      SPARK_BRIDGE_PORT: String(bridgePort),
      SPARK_BRIDGE_TOKEN: this.token,
      SPARK_WORKER_ENTRY: toWinPath(entry),
    };
    this.proc = spawn(path.join(root, 'run-spark.sh'), [toWinPath(path.join(nativeDir, 'wine-host.js'))], {
      env, stdio: ['ignore', out, out], detached: true,
    });
    this.pid = this.proc.pid;
    log(`spawned wine worker pid=${this.pid} entry=${entry}`);
    this.proc.on('spawn', () => this.emit('spawn'));
    this.proc.on('error', (e) => this.emit('error', 'FatalError', 'spawn', String(e)));
    this.proc.on('exit', (code) => {
      log(`wine worker exited code=${code}`);
      this.emit('exit', code ?? 1);
    });
  }

  accept(sock, server) {
    let authed = false;
    readFrames(sock, (frame) => {
      if (!authed) {
        if (frame.k !== 'hello' || frame.token !== this.token) { sock.destroy(); return; }
        authed = true;
        server.close();
        this.sock = sock;
        for (const f of this.pending.splice(0)) writeFrame(sock, f);
        return;
      }
      this.onFrame(frame);
    });
    sock.on('error', (e) => log(`bridge socket error ${e.message}`));
  }

  send(frame) {
    if (this.sock) writeFrame(this.sock, frame);
    else this.pending.push(frame);
  }

  // Own a native port end: relay its messages to the Wine side under an id.
  register(port, id = this.nextId += 2) {
    this.relays.set(id, port);
    port.on('message', (ev) => this.send({ k: 'port', id, data: ev.data, ports: ev.ports.map((p) => this.register(p)) }));
    port.on('close', () => { if (this.relays.delete(id)) this.send({ k: 'closePort', id }); });
    port.start();
    return id;
  }

  // A port the Wine side created: give the app one end of a fresh channel.
  adopt(id) {
    const { MessageChannelMain } = require('electron');
    const channel = new MessageChannelMain();
    this.register(channel.port1, id);
    return channel.port2;
  }

  onFrame(frame) {
    switch (frame.k) {
      case 'parent':
        this.emit('message', frame.data);
        break;
      case 'port': {
        const relay = this.relays.get(frame.id);
        if (relay) relay.postMessage(frame.data, (frame.ports || []).map((id) => this.adopt(id)));
        break;
      }
      case 'closePort': {
        const relay = this.relays.get(frame.id);
        if (relay) { this.relays.delete(frame.id); relay.close(); }
        break;
      }
    }
  }

  postMessage(data, transfer = []) {
    const payload = data && data.type === 'initialize' ? mapPaths(data) : data;
    this.send({ k: 'parent', data: payload, ports: transfer.map((p) => this.register(p)) });
  }

  kill() {
    this.send({ k: 'kill' });
    try { process.kill(-this.proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    return true;
  }
}

const electron = require('electron');
const utility = electron.utilityProcess;
const originalFork = utility.fork.bind(utility);
utility.fork = (modulePath, args, options) => {
  if (/sparkcore-worker[\\/]main\.js$/.test(modulePath)) return new WineWorker(modulePath, options);
  return originalFork(modulePath, args, options);
};
const snapshotDir = process.env.SPARK_NATIVE_SNAPSHOT;
if (snapshotDir) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  electron.app.whenReady().then(() => setTimeout(async () => {
    const windows = electron.BrowserWindow.getAllWindows();
    log(`snapshot: ${windows.length} windows`);
    for (const [i, win] of windows.entries()) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(snapshotDir, `window-${i}.png`), image.toPNG());
      const { width, height } = image.getSize();
      log(`snapshot window ${i}: visible=${win.isVisible()} size=${width}x${height}`);
    }
  }, Number(process.env.SPARK_NATIVE_SNAPSHOT_DELAY_MS || 15000)));
}

log('shim loaded');

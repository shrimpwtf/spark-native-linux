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

const addonStub = require('./addon-stub');
let electronForApp = null;
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron' && electronForApp) return electronForApp;
  if (request === '@readdle/sparkcore-win') return addonStub;
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

// Worker paths point inside the container. Downloads is the host's own folder,
// and the rest of the container's home is the overlay under the state directory.
function toHostPath(p) {
  // The leading slash comes from the pathname of a file:///C:/ URL.
  const match = typeof p === 'string' && /^\/?([A-Za-z]):[\\/](.*)$/s.exec(p);
  if (!match) return p;
  const rest = match[2].replace(/\\/g, '/');
  const home = process.env.HOME || '';
  const user = path.basename(home);
  if (match[1].toUpperCase() === 'C') {
    if (rest.toLowerCase().startsWith(`users/${user}/downloads/`.toLowerCase())) {
      return path.join(home, 'Downloads', rest.split('/').slice(3).join('/'));
    }
    return path.join(prefix, 'drive_c', rest);
  }
  if (match[1].toUpperCase() !== 'Z') return p;
  const unix = `/${rest}`;
  const bound = [home && `${home}/Downloads/`, `${root}/`, `${process.env.SPARK_STATE || root}/`];
  if (!home || !unix.startsWith(`${home}/`) || bound.some((dir) => dir && unix.startsWith(dir))) return unix;
  return path.join(process.env.SPARK_STATE || root, 'test-home', unix.slice(home.length + 1));
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
    this.urlRequests = new Map();

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
      // Spark's core raises no notification events here, so run-spark.sh starts the
      // same database watcher the Wine mode uses and stops it with this worker.
      SPARK_NOTIFY: '1',
      SPARK_CLOSE_TRAY: '0',
      SPARK_IMAGE_BRIDGE: '0',
      SPARK_BRIDGE_PORT: String(bridgePort),
      SPARK_BRIDGE_TOKEN: this.token,
      SPARK_WORKER_ENTRY: toWinPath(entry),
      SPARK_ADDON_PATH: toWinPath(path.join(appDir, 'resources', 'app.asar.unpacked', 'node_modules',
        '@readdle', 'sparkcore-win', 'bin', 'Release', 'SparkCore.bundle', 'SparkCoreAddon')),
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
      case 'urlAction': {
        const request = this.urlRequests.get(frame.id);
        if (!request) break;
        this.urlRequests.delete(frame.id);
        clearTimeout(request.timer);
        if (frame.error) request.reject(new Error(frame.error));
        else request.resolve(frame.action);
        break;
      }
    }
  }

  // Ask the real addon, in Wine, how Spark should treat a URL.
  classifyUrl(url) {
    return new Promise((resolve, reject) => {
      const id = this.nextId += 2;
      const timer = setTimeout(() => {
        this.urlRequests.delete(id);
        reject(new Error('timed out'));
      }, 15000);
      this.urlRequests.set(id, { resolve, reject, timer });
      this.send({ k: 'classifyUrl', id, url, client: 'dist' });
    });
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
let wineWorker = null;
utility.fork = (modulePath, args, options) => {
  if (!/sparkcore-worker[\\/]main\.js$/.test(modulePath)) return originalFork(modulePath, args, options);
  // A forwarding instance is about to quit. It must not open the primary's databases.
  if (!electron.app.hasSingleInstanceLock()) {
    const inert = new EventEmitter();
    inert.postMessage = () => {};
    inert.kill = () => true;
    return inert;
  }
  wineWorker = new WineWorker(modulePath, options);
  return wineWorker;
};

// Mirrors how Spark reads a forwarded URL. Never log the result: it can carry
// an authorization code.
function forwardedUrl(argv) {
  const prefixArg = '--second-instance=';
  const forwarded = argv.find((arg) => arg.startsWith(prefixArg));
  if (!forwarded) return null;
  const args = JSON.parse(forwarded.slice(prefixArg.length));
  const at = args.indexOf('--win-open-url');
  if (at < 0) return null;
  const url = args[at + 1] === '--' ? args[at + 2] : args[at + 1];
  return url && !url.startsWith('-') ? url : null;
}

const appOn = electron.app.on.bind(electron.app);
electron.app.on = (event, listener) => {
  if (event !== 'second-instance') return appOn(event, listener);
  return appOn(event, async (e, argv, ...rest) => {
    let url = null;
    try {
      url = forwardedUrl(argv);
      if (url && wineWorker) {
        const action = await wineWorker.classifyUrl(url);
        addonStub.urlActions.set(url, action);
        log(`forwarded URL action=${action.type}`);
      }
    } catch (error) {
      log(`forwarded URL not classified: ${error.message}`);
    }
    listener(e, argv, ...rest);
    if (url) addonStub.urlActions.delete(url);
  });
};

// The host's URL handlers belong to install-handler.sh. Electron would otherwise
// point them at this runtime.
electron.app.setAsDefaultProtocolClient = () => true;
electron.app.removeAsDefaultProtocolClient = () => true;

// Spark calls these Windows and macOS APIs unguarded because it reports win32.
// A TypeError from one is an unhandled rejection, and Spark quits on those.
electron.app.setUserTasks = () => true;
electron.app.hide = () => {};
electron.systemPreferences.getMediaAccessStatus = () => 'not-determined';
electron.systemPreferences.askForMediaAccess = async () => false;

// The worker's attachment URLs are file:///C:/... and Spark converts them with the
// Linux rules, which gives /C:/... instead of a real path.
const nodeUrl = require('url');
const fileURLToPath = nodeUrl.fileURLToPath;
nodeUrl.fileURLToPath = (url, options) => {
  const converted = fileURLToPath(url, options);
  return /^\/[A-Za-z]:\//.test(converted) ? toHostPath(converted.slice(1)) : converted;
};

// Avatars, previews, and inline images arrive as Windows paths or file:///C:/ URLs.
function toHostFileUrl(value) {
  return /^file:\/\/\/[A-Za-z]:\//i.test(value)
    ? nodeUrl.pathToFileURL(nodeUrl.fileURLToPath(value)).href
    : value;
}
const { protocol, net: electronNet } = electron;
const handleProtocol = protocol.handle.bind(protocol);
protocol.handle = (scheme, handler) => handleProtocol(scheme, (request) => {
  const url = new URL(request.url);
  const filePath = url.searchParams.get('path');
  const fileUrl = url.searchParams.get('fileUrl');
  if (filePath) url.searchParams.set('path', toHostPath(filePath));
  if (fileUrl) url.searchParams.set('fileUrl', toHostFileUrl(fileUrl));
  if (url.href === new URL(request.url).href) return handler(request);
  return handler(new Request(url.href, { method: request.method, headers: request.headers }));
});
const netFetch = electronNet.fetch.bind(electronNet);
electronNet.fetch = (input, init) => netFetch(typeof input === 'string' ? toHostFileUrl(input) : input, init);

const { shell, nativeImage } = electron;
const openPath = shell.openPath.bind(shell);
const showItemInFolder = shell.showItemInFolder.bind(shell);
shell.openPath = (p) => openPath(toHostPath(p));
shell.showItemInFolder = (p) => showItemInFolder(toHostPath(p));

// Spark's tray icon is an .ico, which Electron only decodes on Windows.
function imageFromIco(file) {
  const ico = fs.readFileSync(file);
  let best = null;
  for (let i = 0; i < ico.readUInt16LE(4); i += 1) {
    const at = 6 + i * 16;
    const size = ico[at] || 256;
    if (!best || size > best.size) {
      best = { size, bytes: ico.readUInt32LE(at + 8), offset: ico.readUInt32LE(at + 12) };
    }
  }
  if (!best) return nativeImage.createEmpty();
  const data = ico.subarray(best.offset, best.offset + best.bytes);
  if (data.subarray(1, 4).toString('latin1') === 'PNG') return nativeImage.createFromBuffer(data);
  // Other entries are bottom-up BGRA bitmaps that follow a BITMAPINFOHEADER.
  const row = best.size * 4;
  const bitmap = Buffer.alloc(row * best.size);
  const pixels = data.readUInt32LE(0);
  for (let y = 0; y < best.size; y += 1) {
    data.copy(bitmap, y * row, pixels + (best.size - 1 - y) * row, pixels + (best.size - y) * row);
  }
  return nativeImage.createFromBitmap(bitmap, { width: best.size, height: best.size });
}
// Spark rebuilds its tray after sign-in. On Linux, a second Tray in one process
// collides with the first on D-Bus and stops responding, so keep just one.
const RealTray = electron.Tray;
let sharedTray = null;
let trayDestroyed = false;
function ReusableTray(image) {
  trayDestroyed = false;
  if (sharedTray) {
    sharedTray.setImage(image);
    return sharedTray;
  }
  sharedTray = new RealTray(image);
  sharedTray.destroy = () => {
    trayDestroyed = true;
    sharedTray.setContextMenu(null);
  };
  sharedTray.isDestroyed = () => trayDestroyed;
  return sharedTray;
}
electronForApp = new Proxy(electron, {
  get: (target, prop) => (prop === 'Tray' ? ReusableTray : target[prop]),
});

const createFromPath = nativeImage.createFromPath.bind(nativeImage);
nativeImage.createFromPath = (file) => {
  if (!/\.ico$/i.test(file)) return createFromPath(toHostPath(file));
  try {
    return imageFromIco(file);
  } catch (error) {
    log(`icon not decoded: ${error.message}`);
    return nativeImage.createEmpty();
  }
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

// Spark quits on an unhandled rejection and logs it as {}. Keep the code location,
// but not the message, which can contain account details.
process.on('unhandledRejection', (reason) => {
  const frames = String(reason?.stack || '').split('\n').filter((line) => /^\s+at /.test(line));
  log(`unhandled rejection ${reason?.name || typeof reason}\n${frames.slice(0, 12).join('\n')}`);
});

log('shim loaded');

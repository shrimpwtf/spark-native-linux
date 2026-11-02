'use strict';
// Stand-in for @readdle/sparkcore-win inside the native Electron main process.
// The real addon is a Windows binary and only loads under Wine. Every access
// is recorded so the integrations Spark's main process uses can be inventoried
// and replaced one by one.
const fs = require('fs');
const path = require('path');

const logFile = process.env.SPARK_STUB_LOG || path.join(process.env.TMPDIR || '/tmp', 'spark-addon-stub.log');
const seen = new Set();
function note(what) {
  if (seen.has(what)) return;
  seen.add(what);
  try { fs.appendFileSync(logFile, what + '\n'); } catch { /* logging only */ }
}

const BOOLEAN_FALSE = new Set(['isAvailable']);

function stub(name) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'lift') return undefined;
      if (prop === Symbol.toPrimitive) return () => name;
      if (typeof prop === 'symbol') return undefined;
      if (BOOLEAN_FALSE.has(prop)) return () => false;
      note('get ' + name + '.' + prop);
      return stub(name + '.' + prop);
    },
    apply() {
      note('call ' + name + '()');
      return stub(name + '()');
    },
    construct() {
      note('new ' + name);
      return stub('new ' + name);
    },
  });
}

// URL rules live in the real addon, which only loads under Wine, but Spark asks
// synchronously. The shim resolves a URL over the bridge and stores it here first.
const urlActions = new Map();

// Spark's Windows notification path, shown through the Linux notification service.
class LinuxNotificationManager {
  constructor() {
    this.delegate = null;
    this.live = new Set();
  }
  async subscribe(delegate) {
    this.delegate = delegate;
  }
  async prepare() {}
  async showNotification(title, subtitle, body, action, silent) {
    const { Notification } = require('electron');
    const text = [subtitle, body].filter(Boolean).join('\n');
    const notification = new Notification({ title, body: text, silent: Boolean(silent) });
    const release = () => this.live.delete(notification);
    this.live.add(notification); // An unreferenced notification loses its click handler.
    notification.on('click', () => {
      release();
      this.delegate?.onNotificationWasActivated(action);
    });
    notification.on('close', release);
    notification.on('failed', (_event, error) => {
      release();
      this.delegate?.onErrorOccured(String(error));
    });
    notification.show();
  }
  async cleanup() {
    for (const notification of this.live) notification.close();
    this.live.clear();
  }
}

const overrides = {
  getActionForURLToOpen(url) {
    if (urlActions.has(url)) return urlActions.get(url);
    return typeof url === 'string' && /^mailto:/i.test(url) ? { type: 'mailto', url } : { type: 'unknown' };
  },
  WinRTNotificationManager: LinuxNotificationManager,
};

const KNOWN = new Set([
  'enableStatusMenuItemZeroOrder', 'eventMatcherConstructor', 'remindersEventListenerConstructor',
  'systemEventsListenerConstructor', 'contactsEventListenerConstructor',
  'notificationAuthorizationManagerConstructor', 'previewFiles', 'OpenPrintDialogHandler',
  'getActionForURLToOpen', 'AuthRequest', 'purchaseManagerConstructor', 'updateManagerConstructor',
  'transcriptionServiceConstructor', 'WinRTNotificationManager', 'locationSuggestionsManagerConstructor',
  'openFileInApp', 'ShareExtensionDataService',
]);

const generic = stub('addon');
const addon = new Proxy(generic, {
  get(target, prop) {
    if (typeof prop === 'string' && !KNOWN.has(prop) && !(prop in overrides)) note('NEW addon member: ' + prop);
    return prop in overrides ? overrides[prop] : target[prop];
  },
});

module.exports = { default: addon, urlActions, __esModule: true };

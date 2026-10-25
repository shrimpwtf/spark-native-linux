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

const overrides = {
  getActionForURLToOpen(url) {
    return typeof url === 'string' && /^mailto:/i.test(url) ? { type: 'mailto', url } : { type: 'unknown' };
  },
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

module.exports = { default: addon, __esModule: true };

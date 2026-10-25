'use strict';
// Run with the Linux Electron in node mode so it can read app.asar:
//   ELECTRON_RUN_AS_NODE=1 electron native/check-compat.js [app-dir]
// Exits nonzero when a Spark update breaks an assumption native mode relies on.
const fs = require('fs');
const path = require('path');

const appDir = process.argv[2] || path.join(__dirname, '..', 'app');
const asar = path.join(appDir, 'resources', 'app.asar');
const problems = [];
const need = (ok, message) => { if (!ok) problems.push(message); };
const read = (...parts) => fs.readFileSync(path.join(asar, ...parts), 'utf8');

const pkg = JSON.parse(read('package.json'));
const main = read('dist', 'main', 'main.js');
const workerPath = path.join('dist', 'sparkcore-worker', 'main.js');
need(fs.existsSync(path.join(asar, workerPath)), `worker entry ${workerPath} is missing`);
const worker = fs.existsSync(path.join(asar, workerPath)) ? read(workerPath) : '';

for (const needle of ['utilityProcess.fork', '@readdle/sparkcore-win', 'electron-clipboard-ex', 'getActionForURLToOpen']) {
  need(main.includes(needle), `main bundle no longer mentions ${needle}`);
}
need(worker.includes('parentPort'), 'worker no longer uses process.parentPort');
need(main.includes('MessageChannelMain'), 'main no longer creates MessageChannelMain ports');

const exe = fs.readFileSync(path.join(appDir, 'Spark Desktop.exe'));
const at = exe.indexOf('Electron/');
const bundled = at < 0 ? null : exe.toString('latin1', at + 9, at + 24).match(/^\d+\.\d+\.\d+/)?.[0];
need(bundled, 'cannot read the bundled Electron version from Spark Desktop.exe');
need(bundled === process.versions.electron,
  `Spark bundles Electron ${bundled} but this runtime is ${process.versions.electron}; use the matching Linux build`);

console.log(`Spark ${pkg.version}, bundled Electron ${bundled}, runtime Electron ${process.versions.electron}`);
if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  process.exit(1);
}
console.log('OK native mode assumptions hold');

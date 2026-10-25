'use strict';
// Runs inside Wine under Spark's own Windows Electron started with
// ELECTRON_RUN_AS_NODE=1. It imitates the utility-process environment that
// Spark's sparkcore worker expects (process.parentPort and transferable
// ports) and forwards both over a TCP bridge to the native Electron app.
const net = require('net');
const { EventEmitter } = require('events');
const { writeFrame, readFrames } = require('./frames');

const bridgePort = Number(process.env.SPARK_BRIDGE_PORT);
const token = process.env.SPARK_BRIDGE_TOKEN;
const entry = process.env.SPARK_WORKER_ENTRY;
if (!bridgePort || !token || !entry) {
  process.stderr.write('wine-host: SPARK_BRIDGE_PORT, SPARK_BRIDGE_TOKEN and SPARK_WORKER_ENTRY are required\n');
  process.exit(2);
}

const sock = net.connect(bridgePort, '127.0.0.1');
sock.setNoDelay(true);
const send = (obj) => writeFrame(sock, obj);

const ports = new Map();

class BridgePort extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.started = false;
    this.closed = false;
    this.queue = [];
  }
  postMessage(data, transfer = []) {
    if (this.closed) return;
    send({ k: 'port', id: this.id, data, ports: encode(transfer) });
  }
  deliver(data, portIds) {
    const event = { data, ports: decode(portIds) };
    if (this.started) this.emit('message', event);
    else this.queue.push(event);
  }
  start() {
    this.started = true;
    for (const event of this.queue.splice(0)) this.emit('message', event);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    ports.delete(this.id);
    send({ k: 'closePort', id: this.id });
    this.emit('close');
  }
}

function encode(transfer) {
  return transfer.map((p) => {
    if (!(p instanceof BridgePort)) throw new Error('wine-host: only bridged ports can be transferred');
    return p.id;
  });
}

function decode(ids) {
  return (ids || []).map((id) => {
    let p = ports.get(id);
    if (!p) {
      p = new BridgePort(id);
      ports.set(id, p);
    }
    return p;
  });
}

const parentPort = new EventEmitter();
parentPort.postMessage = (data, transfer = []) => send({ k: 'parent', data, ports: encode(transfer) });
process.parentPort = parentPort;
Object.defineProperty(process, 'type', { value: 'utility', configurable: true });

let started = false;
readFrames(sock, (frame) => {
  switch (frame.k) {
    case 'parent':
      parentPort.emit('message', { data: frame.data, ports: decode(frame.ports) });
      break;
    case 'port': {
      const p = ports.get(frame.id) || decode([frame.id])[0];
      p.deliver(frame.data, frame.ports);
      break;
    }
    case 'closePort': {
      const p = ports.get(frame.id);
      if (p && !p.closed) {
        p.closed = true;
        ports.delete(frame.id);
        p.emit('close');
      }
      break;
    }
    case 'kill':
      process.exit(0);
  }
});

sock.on('connect', () => {
  send({ k: 'hello', token });
  if (started) return;
  started = true;
  require(entry);
});
sock.on('close', () => process.exit(0));
sock.on('error', () => process.exit(1));

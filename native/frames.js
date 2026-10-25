'use strict';
// Length-prefixed v8-serialized frames over a stream socket. Both ends run the
// same Electron/V8 version, so v8.serialize carries Buffers, Dates and Maps.
const v8 = require('v8');

function writeFrame(sock, obj) {
  const body = v8.serialize(obj);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  sock.write(Buffer.concat([head, body]));
}

function readFrames(sock, onFrame) {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onFrame(v8.deserialize(body));
    }
  });
}

module.exports = { writeFrame, readFrames };

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Minimal PNG reader and writer for the device-profile scripts (TODO-073): 8-bit gray, RGB or RGBA, no interlace.
// Decoded pixels are RGBA. Enough for `simctl io screenshot` and `adb exec-out screencap -p` output and test fixtures.
import zlib from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8, width = 0, height = 0, type = 0, depth = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), t = buf.toString("latin1", off + 4, off + 8), d = buf.subarray(off + 8, off + 8 + len);
    if (t === "IHDR") { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === "IDAT") idat.push(d);
    else if (t === "IEND") break;
    off += 12 + len;
  }
  const ch = CHANNELS[type];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * ch, out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++], line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = 0;
      if (f === 1) v = a; else if (f === 2) v = b; else if (f === 3) v = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + v) & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * ch, o = (y * width + x) * 4;
      if (ch >= 3) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = ch === 4 ? line[s + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = ch === 2 ? line[s + 1] : 255; }
    }
    prev = line;
  }
  return { width, height, data: out };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32BE(d.length); h.write(t, 4, "latin1"); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([h.subarray(4), d]))); return Buffer.concat([h, d, c]); };

/** RGBA pixels -> PNG (filter 0). */
export function encode({ width, height, data }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { parseDepthPacket, depthMm, imagePixel, colorizeDepth, depthPng } from '../src/depth-data.js';

function frame() {
  const meta = { version: 1, encoding: 'z16-le', width: 3, height: 1, depth_scale_m: .0001 };
  const header = new TextEncoder().encode(JSON.stringify(meta));
  const buffer = new ArrayBuffer(4 + header.length + 6), view = new DataView(buffer);
  view.setUint32(0, header.length, true); new Uint8Array(buffer, 4, header.length).set(header);
  [0, 1234, 65535].forEach((value, i) => view.setUint16(4 + header.length + i * 2, value, true));
  return parseDepthPacket(buffer);
}

test('native Z16 uses device scale; zero and out-of-image are invalid', () => {
  const f = frame();
  assert.equal(depthMm(f, 0, 0), null);
  assert.ok(Math.abs(depthMm(f, 1, 0) - 123.4) < 1e-8);
  assert.equal(depthMm(f, 3, 0), null);
  assert.throws(() => parseDepthPacket(new ArrayBuffer(6)));
});

test('filtered preview is decoded separately and never replaces raw measurements', () => {
  const meta = { version: 2, encoding: 'z16-le-pair', width: 2, height: 1, depth_scale_m: .0001 };
  const header = new TextEncoder().encode(JSON.stringify(meta));
  const buffer = new ArrayBuffer(4 + header.length + 8), view = new DataView(buffer);
  view.setUint32(0, header.length, true); new Uint8Array(buffer, 4, header.length).set(header);
  [0, 1234, 1200, 1240].forEach((v, i) => view.setUint16(4 + header.length + i * 2, v, true));
  const f = parseDepthPacket(buffer);
  assert.deepEqual([...f.filtered], [1200, 1240]);
  assert.equal(depthMm(f, 0, 0), null);
  assert.ok(Math.abs(depthMm(f, 1, 0) - 123.4) < 1e-8);
  assert.throws(() => parseDepthPacket(buffer.slice(0, -2)));
});

test('measurement pixels account for object-fit letterboxing and reject borders', () => {
  const rect = { left: 20, top: 30, width: 300, height: 300 };
  assert.equal(imagePixel(170, 40, rect, 640, 480), null);
  assert.deepEqual(imagePixel(170, 180, rect, 640, 480), [320, 240]);
  assert.equal(imagePixel(320, 180, rect, 640, 480), null);
});

test('invalid and outside-scale pixels have distinct colors without changing measurements', () => {
  const f = frame(), before = [...f.pixels], colors = colorizeDepth(f, 50, 500);
  assert.deepEqual([...colors.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...colors.slice(8, 12)], [68, 78, 91, 255]);
  assert.notDeepEqual([...colors.slice(4, 8)], [0, 0, 0, 255]);
  assert.deepEqual([...f.pixels], before);
});

test('PNG download preserves 16-bit depth and embeds scale metadata', async () => {
  const source = frame(); source.filtered = new Uint16Array([999, 999, 999]);
  const png = new Uint8Array(await (await depthPng(source)).arrayBuffer());
  const view = new DataView(png.buffer);
  assert.equal(png[24], 16); assert.equal(png[25], 0);
  let offset = 8, sawText = false, sawDepth = false;
  while (offset < png.length) {
    const size = view.getUint32(offset), name = new TextDecoder().decode(png.slice(offset + 4, offset + 8));
    const bytes = png.slice(offset + 8, offset + 8 + size);
    if (name === 'tEXt') { assert.match(new TextDecoder().decode(bytes), /"depth_scale_m":0.0001/); sawText = true; }
    if (name === 'IDAT') { assert.deepEqual([...inflateSync(bytes)], [0, 0, 0, 4, 210, 255, 255]); sawDepth = true; }
    offset += size + 12;
  }
  assert.ok(sawText && sawDepth);
});

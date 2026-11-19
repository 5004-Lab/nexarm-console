import test from 'node:test';
import assert from 'node:assert/strict';
import { fillDepthHoles, fillSurfaceHoles } from '../src/depth-fill.js';
import { depthMm } from '../src/depth-data.js';

test('closed surface holes fill from both axes without changing observed pixels or raw measurements', () => {
  const width = 40, height = 40, pixels = new Uint16Array(width * height).fill(3000);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) pixels[y * width + x] = 0;
  const { pixels: preview, filledCount } = fillDepthHoles(pixels, width, height, .0001);
  assert.equal(filledCount, 100);
  assert.ok(preview.every(value => value === 3000));
  assert.equal(pixels[15 * width + 15], 0);
  assert.equal(depthMm({ pixels, meta: { width, height, depth_scale_m: .0001 } }, 15, 15), null);
});

test('linear sloped surface is reconstructed consistently rather than copied from one side', () => {
  const width = 32, height = 32, pixels = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = 2000 + 3 * x + 2 * y;
  const expected = pixels.slice();
  for (let y = 9; y < 15; y++) for (let x = 9; x < 17; x++) pixels[y * width + x] = 0;
  assert.deepEqual(fillDepthHoles(pixels, width, height, .0001).pixels, expected);
});

test('depth discontinuities and conflicting horizontal/vertical surfaces are not bridged', () => {
  const width = 21, height = 21, pixels = new Uint16Array(width * height).fill(2000);
  for (let y = 0; y < height; y++) for (let x = 11; x < width; x++) pixels[y * width + x] = 4000;
  pixels[10 * width + 10] = 0;
  assert.equal(fillDepthHoles(pixels, width, height, .0001).pixels[10 * width + 10], 0);
  const cross = new Uint16Array(25).fill(2000);
  cross[7] = 4000; cross[17] = 4000; cross[12] = 0;
  assert.equal(fillDepthHoles(cross, 5, 5, .0001).pixels[12], 0);
});

test('border-connected holes and gaps larger than the bound stay unfilled', () => {
  const width = 50, height = 50, pixels = new Uint16Array(width * height).fill(2000);
  for (let y = 5; y < 45; y++) for (let x = 5; x < 45; x++) pixels[y * width + x] = 0;
  assert.equal(fillDepthHoles(pixels, width, height, .0001).filledCount, 0);
  pixels.fill(2000);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) pixels[y * width + x] = 0;
  assert.equal(fillDepthHoles(pixels, width, height, .0001).filledCount, 0);
});

test('a bent missing-depth path to the border is not mistaken for an enclosed hole', () => {
  const width = 40, height = 40, pixels = new Uint16Array(width * height).fill(2500);
  for (let y = 12; y < 18; y++) for (let x = 12; x < 18; x++) pixels[y * width + x] = 0;
  for (let x = 0; x < 15; x++) pixels[10 * width + x] = 0;
  for (let y = 10; y < 15; y++) pixels[y * width + 14] = 0;
  assert.equal(fillDepthHoles(pixels, width, height, .0001).filledCount, 0);
});

test('scene preview completes a narrow open surface gap without modifying its source', () => {
  const width = 50, height = 50, pixels = new Uint16Array(width * height).fill(3000);
  for (let y = 0; y < height; y++) for (let x = 22; x < 28; x++) pixels[y * width + x] = 0;
  const result = fillSurfaceHoles(pixels, width, height, .0001);
  assert.equal(result.pixels[25 * width + 25], 3000);
  assert.equal(pixels[25 * width + 25], 0);
  assert.ok(result.filledCount > 0);
});

test('scene preview preserves an unsupported large void and a conflicting depth boundary', () => {
  const width = 80, height = 80, pixels = new Uint16Array(width * height).fill(2000);
  for (let y = 15; y < 65; y++) for (let x = 15; x < 65; x++) pixels[y * width + x] = 0;
  assert.equal(fillSurfaceHoles(pixels, width, height, .0001).pixels[40 * width + 40], 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = x < 38 ? 2000 : x > 42 ? 4000 : 0;
  assert.equal(fillSurfaceHoles(pixels, width, height, .0001).pixels[40 * width + 40], 0);
  pixels.fill(0);
  assert.ok(fillSurfaceHoles(pixels, width, height, .0001).pixels.every(value => value === 0));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameHealth } from '../src/frame-health.js';

test('a brief network or no-new-frame response keeps the decoded frame available', () => {
  const state = new FrameHealth(); state.received(100);
  for (const mode of ['live', 'waiting', 'unavailable']) {
    assert.deepEqual(state.check(mode, 900), { hasFrame: true, paused: false, resetCursor: false });
  }
});

test('prolonged gaps retain the image but mark it paused and reset the source cursor', () => {
  const state = new FrameHealth(); state.received(100);
  assert.deepEqual(state.check('waiting', 2100), { hasFrame: true, paused: true, resetCursor: true });
  state.received(2200);
  assert.deepEqual(state.check('live', 2200), { hasFrame: true, paused: false, resetCursor: false });
});

test('explicit disconnect is paused immediately; first connection never invents an image', () => {
  const state = new FrameHealth();
  assert.deepEqual(state.check('missing', 10), { hasFrame: false, paused: false, resetCursor: false });
  state.received(100);
  assert.deepEqual(state.check('missing', 101), { hasFrame: true, paused: true, resetCursor: true });
});

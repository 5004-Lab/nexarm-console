import test from 'node:test';
import assert from 'node:assert/strict';
import { toScene, fromScene, nudgeTarget, targetKey } from '../src/target-space.js';

test('base X/Y/Z round trip through the scene axes, including signs', () => {
  assert.deepEqual(toScene([100, 200, 300]), [.1, .3, -.2]);
  assert.deepEqual(fromScene([-.1, .25, .15]), [-100, -150, 250]);
  for (const point of [[100, 200, 300], [-120.5, -30.2, 50.1], [0, 0, 120]]) assert.deepEqual(fromScene(toScene(point)), point);
});
test('a millimeter nudge changes exactly the requested base axis', () => {
  assert.deepEqual(nudgeTarget([10,20,30], 'Z', 1, 5), [10,20,35]);
  assert.deepEqual(nudgeTarget([10,20,30], 'Y', -1, 1), [10,19,30]);
  assert.throws(() => nudgeTarget([10,20,30], 'W', 1, 5));
});
test('target validation keys change on XYZ edits and reject nonfinite inputs', () => {
  assert.notEqual(targetKey([10,20,30]), targetKey([10,20,31]));
  assert.equal(targetKey([NaN,20,30]), '');
});

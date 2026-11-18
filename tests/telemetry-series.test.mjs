import test from 'node:test';
import assert from 'node:assert/strict';
import { plotSamples, channelPoints, nearestSample, readingLabel, timeTooltip } from '../src/telemetry-series.js';

const names = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
const longRun = () => Array.from({ length: 16000 }, (_, i) => ({ stamp: 5000 + i * .1, values: [-88.58, 45.33, -16.6, 51.45, 17.23, 31.87] }));

test('a 1600 second continuous six-axis record stays continuous after reduction', () => {
  const raw = longRun(), display = plotSamples(raw, 6);
  assert.ok(display.length < 6000);
  assert.ok(display.some((sample, i) => i && sample.stamp - display[i-1].stamp > .6));
  for (let channel = 0; channel < 6; channel++) {
    const points = channelPoints(display, channel, raw[0].stamp);
    assert.ok(points.every(point => Number.isFinite(point[1])));
    assert.equal(points[0][0], 0);
    assert.ok(points.at(-1)[0] > 1599);
  }
});

test('real acquisition gaps are preserved even inside a reduction bucket', () => {
  const raw = longRun();
  for (let i=8013; i<raw.length; i++) raw[i].stamp += 3;
  const display = plotSamples(raw, 6);
  assert.equal(display.filter(sample => sample.breakBefore).length, 1);
  assert.equal(channelPoints(display, 0, raw[0].stamp).filter(point => point[1] === null).length, 1);
  assert.equal(nearestSample(raw, raw[8012].stamp + 1.5), null);
});

test('positive and negative spikes and per-channel missing runs survive reduction', () => {
  const raw = longRun().map(sample => ({ ...sample, values: [...sample.values] }));
  raw[1234].values[2] = 179;
  raw[6789].values[1] = -170;
  for (let i=10000; i<10100; i++) raw[i].values[4] = null;
  const display = plotSamples(raw, 6);
  assert.ok(display.some(sample => sample.values[2] === 179));
  assert.ok(display.some(sample => sample.values[1] === -170));
  assert.ok(channelPoints(display, 4, raw[0].stamp).some(point => point[1] === null));
  assert.ok(channelPoints(display, 0, raw[0].stamp).every(point => point[1] !== null));
  assert.equal(raw.length, 16000);
});

test('empty channels remain bounded and do not manufacture zero readings', () => {
  const display = plotSamples(longRun().map(sample => ({ ...sample, values: null })), 6);
  assert.ok(display.length < 1000);
  assert.ok(channelPoints(display, 0, 5000).every(point => point[1] === null));
  assert.deepEqual(plotSamples([], 6), []);
});

test('tooltips read numeric values from the original long record', () => {
  const raw = longRun();
  const tooltip = timeTooltip(raw, 876.54, raw[0].stamp, names);
  assert.match(tooltip, /J1  -88.58/);
  assert.match(tooltip, /J6  31.87/);
  assert.ok(!tooltip.includes('—'));
  assert.equal(readingLabel([876.5, -88.58]), '-88.58');
  assert.equal(readingLabel(0), '0');
  assert.equal(readingLabel(null), '—');
});

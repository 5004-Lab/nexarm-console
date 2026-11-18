// Mark real acquisition gaps before reducing points for display.
export function plotSamples(source, channels, threshold = 6000, buckets = 400, gapSeconds = 0.6) {
  if (!source.length) return [];
  const gaps = new Set();
  const selected = new Set([0, source.length - 1]);
  for (let i = 1; i < source.length; i++) {
    if (source[i].stamp - source[i - 1].stamp > gapSeconds + 1e-9) {
      gaps.add(i); selected.add(i - 1); selected.add(i);
    }
    for (let channel = 0; channel < channels; channel++) {
      if (Number.isFinite(source[i].values?.[channel]) !== Number.isFinite(source[i - 1].values?.[channel])) {
        selected.add(i - 1); selected.add(i);
      }
    }
  }
  if (source.length <= threshold) return source.map((sample, i) => ({ ...sample, breakBefore: gaps.has(i) }));
  const bucketSize = Math.ceil(source.length / buckets);
  for (let start = 0; start < source.length; start += bucketSize) {
    const end = Math.min(source.length, start + bucketSize);
    selected.add(start); selected.add(end - 1);
    for (let channel = 0; channel < channels; channel++) {
      let low, high;
      for (let i = start; i < end; i++) {
        const value = source[i].values?.[channel];
        if (!Number.isFinite(value)) continue;
        if (low == null || value < source[low].values[channel]) low = i;
        if (high == null || value > source[high].values[channel]) high = i;
      }
      if (low != null) selected.add(low);
      if (high != null) selected.add(high);
    }
  }
  return [...selected].sort((a, b) => a - b).map(i => ({ ...source[i], breakBefore: gaps.has(i) }));
}

export function channelPoints(samples, channel, origin) {
  return samples.flatMap(sample => {
    const t = sample.stamp - origin;
    const value = sample.values?.[channel];
    const point = [t, Number.isFinite(value) ? value : null];
    return sample.breakBefore ? [[t - 0.001, null], point] : [point];
  });
}

export function nearestSample(samples, stamp, tolerance = 0.6) {
  if (!samples.length || !Number.isFinite(stamp)) return null;
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (samples[middle].stamp < stamp) lo = middle + 1;
    else hi = middle;
  }
  const before = samples[lo - 1], after = samples[lo];
  const sample = !before ? after : !after ? before : stamp - before.stamp <= after.stamp - stamp ? before : after;
  return sample && Math.abs(sample.stamp - stamp) <= tolerance ? sample : null;
}

export function readingLabel(value) {
  // ECharts may pass the complete [time, reading] value to a value formatter.
  const number = Array.isArray(value) ? value.at(-1) : value;
  return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : '—';
}

export function timeTooltip(source, elapsed, origin, names) {
  const sample = nearestSample(source, origin + elapsed);
  const title = sample ? `${readingLabel(sample.stamp - origin)} s` : `${readingLabel(elapsed)} s · 无采样`;
  return [title, ...names.map((name, i) => `${name}  ${readingLabel(sample?.values?.[i])}`)].join('\n');
}

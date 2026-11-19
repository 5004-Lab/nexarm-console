// Display-only interpolation. Never mutate or replace the native measurement plane.
export function fillDepthHoles(pixels, width, height, scaleM, { maxGap = 32 } = {}) {
  if (!(pixels instanceof Uint16Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || pixels.length !== width * height || !Number.isFinite(scaleM) || scaleM <= 0 ||
      !Number.isInteger(maxGap) || maxGap < 1 || maxGap > 128) throw Error('Invalid depth interpolation input');
  const horizontal = new Float32Array(pixels.length);
  const result = pixels.slice();
  const components = new Uint8Array(pixels.length), queue = new Uint32Array(pixels.length);
  let tail = 0;
  const visit = index => {
    if (!pixels[index] && !components[index]) { components[index] = 1; queue[tail++] = index; }
  };
  // Only enclosed, bounded components qualify. This rejects occlusion bands connected
  // to the image border, including narrow/bent paths not detectable by local spans.
  for (let index = 0; index < pixels.length; index++) {
    if (pixels[index] || components[index]) continue;
    tail = 0; visit(index);
    let head = 0, minX = width, maxX = 0, minY = height, maxY = 0;
    while (head < tail) {
      const i = queue[head++], x = i % width, y = Math.floor(i / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    if (minX > 0 && minY > 0 && maxX < width - 1 && maxY < height - 1 &&
        maxX - minX + 1 <= maxGap && maxY - minY + 1 <= maxGap) {
      for (let n = 0; n < tail; n++) components[queue[n]] = 2;
    }
  }
  const unitsPerMm = 1 / (scaleM * 1000);
  // Endpoints may belong to a gently sloped surface, but not a large depth step.
  const boundaryAgrees = (a, b) => Math.abs(a - b) <= Math.max(12 * unitsPerMm, (a + b) * .025);
  for (let y = 0; y < height; y++) {
    let left = -1;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const rightValue = pixels[row + x];
      if (!rightValue) continue;
      const gap = x - left - 1;
      if (left >= 0 && gap > 0 && gap <= maxGap) {
        const leftValue = pixels[row + left];
        if (boundaryAgrees(leftValue, rightValue)) {
          for (let n = 1; n <= gap; n++) horizontal[row + left + n] = leftValue + (rightValue - leftValue) * n / (gap + 1);
        }
      }
      left = x;
    }
  }
  let filledCount = 0;
  for (let x = 0; x < width; x++) {
    let top = -1;
    for (let y = 0; y < height; y++) {
      const bottomValue = pixels[y * width + x];
      if (!bottomValue) continue;
      const gap = y - top - 1;
      if (top >= 0 && gap > 0 && gap <= maxGap) {
        const topValue = pixels[top * width + x];
        if (boundaryAgrees(topValue, bottomValue)) {
          for (let n = 1; n <= gap; n++) {
            const index = (top + n) * width + x, h = horizontal[index];
            if (!h || components[index] !== 2) continue;
            const v = topValue + (bottomValue - topValue) * n / (gap + 1);
            // Both axes must describe the same surface. No iterative outward spreading.
            if (Math.abs(h - v) <= Math.max(5 * unitsPerMm, (h + v) * .0075)) {
              result[index] = Math.round((h + v) / 2);
              filledCount++;
            }
          }
        }
      }
      top = y;
    }
  }
  return { pixels: result, filledCount };
}

// Stronger visualization: normalized inverse-depth interpolation in a bounded
// neighborhood. Source support is always the original filtered plane, never a
// previously completed pixel. This may extend surfaces into unmeasured space.
export function fillSurfaceHoles(pixels, width, height, scaleM) {
  const strict = fillDepthHoles(pixels, width, height, scaleM);
  const stride = width + 1, size = stride * (height + 1);
  const count = new Uint32Array(size), sum = new Float64Array(size), square = new Float64Array(size);
  for (let y = 1; y <= height; y++) {
    let n = 0, s = 0, q = 0;
    for (let x = 1; x <= width; x++) {
      const value = pixels[(y - 1) * width + x - 1], inverse = value ? 1 / value : 0;
      if (value) n++;
      s += inverse; q += inverse * inverse;
      const index = y * stride + x, above = index - stride;
      count[index] = count[above] + n; sum[index] = sum[above] + s; square[index] = square[above] + q;
    }
  }
  let filledCount = strict.filledCount;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (strict.pixels[index]) continue;
    for (const radius of [2, 4, 8, 12]) {
      const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
      const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
      const a = top * stride + left, b = top * stride + right, c = bottom * stride + left, d = bottom * stride + right;
      const n = count[d] - count[b] - count[c] + count[a];
      if (n < Math.max(6, (right - left) * (bottom - top) * .25)) continue;
      const mean = (sum[d] - sum[b] - sum[c] + sum[a]) / n;
      const variance = Math.max(0, (square[d] - square[b] - square[c] + square[a]) / n - mean * mean);
      if (mean <= 0 || variance > mean * mean * .035 ** 2) continue;
      strict.pixels[index] = Math.round(1 / mean);
      filledCount++;
      break;
    }
  }
  return { pixels: strict.pixels, filledCount };
}

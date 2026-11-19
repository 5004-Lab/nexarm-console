// The color image is a view of native Z16 data; measurements always use Z16.
export const depthColors = [[249,115,22], [250,204,21], [34,197,94], [6,182,212], [37,99,235]];

export function parseDepthPacket(buffer) {
  if (buffer.byteLength < 4) throw Error('深度数据包不完整');
  const length = new DataView(buffer).getUint32(0, true);
  if (!length || length > 65536 || length + 4 > buffer.byteLength) throw Error('深度元数据无效');
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  const { width, height, depth_scale_m: scale } = meta;
  if (meta.version !== 1 || meta.encoding !== 'z16-le' || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width * height > 4_000_000 || !Number.isFinite(scale) || scale <= 0 ||
      buffer.byteLength !== 4 + length + width * height * 2) throw Error('深度格式或尺寸无效');
  // JSON length need not be aligned to a uint16 boundary.
  const data = new DataView(buffer, 4 + length);
  const pixels = new Uint16Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = data.getUint16(i * 2, true);
  return { meta, pixels };
}

export function depthMm(frame, x, y) {
  if (!frame || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
      x >= frame.meta.width || y >= frame.meta.height) return null;
  const raw = frame.pixels[y * frame.meta.width + x];
  return raw ? raw * frame.meta.depth_scale_m * 1000 : null;
}

export function imagePixel(clientX, clientY, rect, width, height) {
  const scale = Math.min(rect.width / width, rect.height / height);
  const left = rect.left + (rect.width - width * scale) / 2;
  const top = rect.top + (rect.height - height * scale) / 2;
  const x = Math.floor((clientX - left) / scale), y = Math.floor((clientY - top) / scale);
  return x >= 0 && y >= 0 && x < width && y < height ? [x, y] : null;
}

export function colorizeDepth(frame, near, far) {
  if (!Number.isFinite(near) || !Number.isFinite(far) || near < 0 || far <= near) throw Error('深度显示范围无效');
  const colors = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const value = i / 255 * (depthColors.length - 1);
    const index = Math.min(Math.floor(value), depthColors.length - 2), fraction = value - index;
    for (let c = 0; c < 3; c++) colors[i * 4 + c] = depthColors[index][c] * (1 - fraction) + depthColors[index + 1][c] * fraction;
    colors[i * 4 + 3] = 255;
  }
  const result = new Uint8ClampedArray(frame.pixels.length * 4);
  const multiplier = frame.meta.depth_scale_m * 1000;
  for (let i = 0; i < frame.pixels.length; i++) {
    const raw = frame.pixels[i], mm = raw * multiplier, offset = i * 4;
    result[offset + 3] = 255;
    if (!raw) continue;
    if (mm < near || mm > far) {
      result[offset] = 68; result[offset + 1] = 78; result[offset + 2] = 91;
    } else {
      const color = Math.round((mm - near) / (far - near) * 255) * 4;
      result[offset] = colors[color]; result[offset + 1] = colors[color + 1]; result[offset + 2] = colors[color + 2];
    }
  }
  return result;
}

function pngChunk(name, data) {
  const chunk = new Uint8Array(data.length + 12), view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(name), 4); chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < data.length + 8; i++) {
    crc ^= chunk[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  view.setUint32(data.length + 8, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

export async function depthPng(frame) {
  const { width, height } = frame.meta;
  const scan = new Uint8Array(height * (width * 2 + 1));
  const view = new DataView(scan.buffer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) view.setUint16(y * (width * 2 + 1) + 1 + x * 2, frame.pixels[y * width + x]);
  }
  const compression = new Blob([scan]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(compression).arrayBuffer());
  const header = new Uint8Array(13), h = new DataView(header.buffer);
  h.setUint32(0, width); h.setUint32(4, height); header[8] = 16; // grayscale uint16, lossless
  const text = new TextEncoder().encode('nexarm\0' + JSON.stringify(frame.meta));
  return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header),
    pngChunk('tEXt', text), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())], { type: 'image/png' });
}

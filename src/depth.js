import { parseDepthPacket, depthMm, imagePixel, colorizeDepth, depthPng, depthColors } from './depth-data.js';

export const depthPanel = `
  <section class="depth-panel panel" id="depth-camera" aria-label="RealSense D405 深度视图">
    <header class="panel-header"><div class="panel-title"><h2>D405 深度</h2><span class="depth-state status-label">连接中</span></div>
      <div class="views"><button type="button" id="depth-freeze" disabled>冻结</button><button type="button" id="depth-fullscreen">放大</button></div></header>
    <div class="depth-image visual-frame" tabindex="0" aria-label="深度画面，移动指针查看距离，点击固定测量像素"><canvas hidden></canvas><p class="camera-message">正在连接 RealSense D405…</p><span class="depth-live-note">光轴深度 Z · 非基座坐标</span><output class="depth-floating-reading"></output><button type="button" class="depth-exit">退出全屏</button></div>
    <div class="depth-readout"><div><span id="depth-pixel">中心像素</span><strong id="depth-value">— mm</strong></div><span id="depth-quality">等待原始深度</span></div>
    <div class="depth-scale"><label>标尺<select id="depth-range" aria-label="深度显示范围"><option value="50,500">50–500 mm</option><option value="50,1000" selected>50–1000 mm</option><option value="50,3000">50–3000 mm</option></select></label><div class="depth-color-key"><div class="depth-gradient"></div><span><b id="depth-near">50 mm</b><b id="depth-far">1000 mm</b></span></div></div>
    <footer class="view-footer depth-footer"><span id="depth-details">黑：无效 · 灰：标尺外</span><div class="camera-tools"><button type="button" id="depth-unpin">跟随指针</button><button type="button" id="depth-download" disabled>16位原图 ↓</button></div></footer>
  </section>`;

export function createDepth(panel) {
  const $ = selector => panel.querySelector(selector);
  const canvas = $('canvas'), context = canvas.getContext('2d');
  const image = $('.depth-image'), message = $('.camera-message'), badge = $('.depth-state');
  const freeze = $('#depth-freeze'), download = $('#depth-download');
  let frame = null, after = 0, active = true, frozen = false, pinned = false, pixel = null, background = null;
  let rateStart = performance.now(), frames = 0, rate = null;
  $('.depth-gradient').style.background = `linear-gradient(to right, ${depthColors.map(color => `rgb(${color.join(',')})`).join(',')})`;

  function reading() {
    const value = frame && pixel ? depthMm(frame, ...pixel) : null;
    $('#depth-pixel').textContent = pixel ? `${pinned ? '固定' : '像素'} (${pixel.join(', ')})` : '中心像素';
    $('#depth-value').textContent = value === null ? '无有效深度' : `${value.toFixed(1)} mm`;
    $('#depth-value').dataset.valid = String(value !== null);
    $('.depth-floating-reading').textContent = `${$('#depth-pixel').textContent} · ${$('#depth-value').textContent}`;
    $('#depth-unpin').disabled = !pinned;
  }
  function draw() {
    if (!frame) return;
    const { width, height } = frame.meta;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const [near, far] = $('#depth-range').value.split(',').map(Number);
    $('#depth-near').textContent = `${near} mm`; $('#depth-far').textContent = `${far} mm`;
    if (!background) background = new ImageData(colorizeDepth(frame, near, far), width, height);
    context.putImageData(background, 0, 0);
    if (!pixel || pixel[0] >= width || pixel[1] >= height) pixel = [Math.floor(width / 2), Math.floor(height / 2)];
    const [x, y] = pixel;
    context.strokeStyle = '#fff'; context.lineWidth = 1.5;
    context.beginPath(); context.moveTo(x - 9, y); context.lineTo(x + 9, y); context.moveTo(x, y - 9); context.lineTo(x, y + 9); context.stroke();
    context.strokeStyle = '#111'; context.lineWidth = 1; context.strokeRect(x - 4.5, y - 4.5, 9, 9);
    reading();
  }
  function lost(status) {
    frame = null; pixel = null; pinned = false; after = 0; canvas.hidden = true;
    $('#depth-unpin').disabled = true;
    freeze.disabled = true; download.disabled = true; badge.textContent = status === 'missing' ? '未连接' : '等待深度';
    message.textContent = ({ missing: '未检测到 D405，请检查 USB 连接', unsupported: '深度采集组件未安装',
      disabled: '服务器尚未启用深度采集', unavailable: '深度相机暂时无法读取，正在重试' })[status] || '正在等待新的深度帧…';
    message.hidden = false; $('#depth-value').textContent = '— mm'; $('#depth-quality').textContent = '无实时深度';
    $('#depth-details').textContent = '黑：无效 · 灰：标尺外';
    $('.depth-floating-reading').textContent = '';
  }
  async function poll() {
    let delay = 75;
    try {
      if (frozen || document.hidden || panel.closest('.work-page')?.hidden) return;
      const response = await fetch(`/api/depth?after=${after}`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (!active || frozen) return;
      if (response.status === 200) {
        const next = parseDepthPacket(await response.arrayBuffer());
        if (!active || frozen) return;
        frame = next; background = null; after = frame.meta.stamp;
        canvas.hidden = false; message.hidden = true; freeze.disabled = false; download.disabled = false;
        const now = performance.now(); frames++;
        if (now - rateStart > 1000) { rate = Math.round(frames * 1000 / (now - rateStart)); frames = 0; rateStart = now; }
        badge.textContent = '实时深度';
        $('#depth-quality').textContent = `有效像素 ${frame.meta.valid_percent}%`;
        $('#depth-details').textContent = `${frame.meta.width} × ${frame.meta.height}${rate === null ? '' : ` · ${rate} fps`} · 黑：无效 · 灰：标尺外`;
        draw();
      } else if (response.status === 204) {
        const status = response.headers.get('X-Camera-State');
        if (status !== 'live') { lost(status); delay = 700; }
      } else { lost(response.status === 404 ? 'disabled' : 'unavailable'); delay = 1000; }
    } catch { if (!frozen) lost('unavailable'); delay = 700; }
    finally { if (active) setTimeout(poll, frozen || document.hidden ? 500 : delay); }
  }
  image.addEventListener('pointermove', event => {
    if (!frame || pinned) return;
    const point = imagePixel(event.clientX, event.clientY, image.getBoundingClientRect(), frame.meta.width, frame.meta.height);
    if (point) { pixel = point; draw(); }
  });
  image.addEventListener('click', event => {
    if (!frame) return;
    const point = imagePixel(event.clientX, event.clientY, image.getBoundingClientRect(), frame.meta.width, frame.meta.height);
    if (point) { pixel = point; pinned = true; draw(); }
  });
  $('#depth-unpin').onclick = () => { pinned = false; reading(); };
  $('#depth-range').onchange = () => { background = null; draw(); };
  $('#depth-fullscreen').onclick = () => image.requestFullscreen();
  $('.depth-exit').onclick = event => { event.stopPropagation(); document.exitFullscreen(); };
  freeze.onclick = () => {
    frozen = !frozen; freeze.textContent = frozen ? '恢复实时' : '冻结';
    badge.textContent = frozen ? '已冻结' : '等待新帧';
    $('.depth-live-note').textContent = frozen ? `冻结于 ${new Date(frame.meta.captured_at_ms).toLocaleTimeString()} · 光轴深度 Z` : '光轴深度 Z · 非基座坐标';
    if (!frozen) { rateStart = performance.now(); frames = 0; }
  };
  download.onclick = async () => {
    const saved = frame;
    if (!saved) return;
    download.disabled = true;
    try {
      const blob = await depthPng(saved), url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: `D405-depth-${saved.meta.captured_at_ms}.png` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } finally { download.disabled = !frame; }
  };
  window.addEventListener('pagehide', () => { active = false; });
  window.addEventListener('pageshow', event => { if (event.persisted && !active) { active = true; poll(); } });
  $('#depth-unpin').disabled = true;
  poll();
}

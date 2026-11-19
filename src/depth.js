import { parseDepthPacket, colorizeDepth, depthPng, depthColors } from './depth-data.js';
import { fillDepthHoles, fillSurfaceHoles } from './depth-fill.js';
import { FrameHealth } from './frame-health.js';

export const depthPanel = `
  <section class="depth-panel panel" id="depth-camera" aria-label="RealSense D405 深度视图">
    <header class="panel-header"><div class="panel-title"><h2>D405 深度</h2><span class="depth-state status-label">连接中</span></div>
      <div class="views"><button type="button" id="depth-relief" aria-label="表面光照增强" aria-pressed="false" title="显示增强：会放大局部深度起伏，不代表真实凹凸">起伏</button><button type="button" id="depth-freeze" disabled>冻结</button><button type="button" id="depth-fullscreen">放大</button></div></header>
    <div class="depth-image visual-frame" aria-label="D405 深度实时画面"><canvas hidden></canvas><p class="camera-message">正在连接 RealSense D405…</p><button type="button" class="depth-exit">退出全屏</button></div>
    <div class="depth-scale"><label>显示<select id="depth-mode" aria-label="深度处理模式"><option value="scene" selected>场景补洞（推算）</option><option value="complete">稳健补洞</option><option value="enhanced">保边滤波</option><option value="raw">原始深度</option></select></label><label>标尺<select id="depth-range" aria-label="深度显示范围"><option value="auto" selected>自动近景</option><option value="50,500">50–500 mm</option><option value="50,1000">50–1000 mm</option><option value="50,3000">50–3000 mm</option></select></label><div class="depth-color-key"><div class="depth-gradient"></div><span><b id="depth-near">50 mm</b><b id="depth-far">1000 mm</b></span></div></div>
    <footer class="view-footer depth-footer"><span id="depth-details">等待画面</span><div class="camera-tools"><button type="button" id="depth-download" disabled>16位原图 ↓</button></div></footer>
  </section>`;

export function createDepth(panel) {
  const $ = selector => panel.querySelector(selector);
  const canvas = $('.depth-image canvas'), context = canvas.getContext('2d');
  const image = $('.depth-image'), message = $('.camera-message'), badge = $('.depth-state');
  const freeze = $('#depth-freeze'), download = $('#depth-download');
  let frame = null, after = 0, active = true, frozen = false, background = null;
  const section = $('#depth-camera');
  const health = new FrameHealth();
  let autoRange = null;
  let completed = null;
  let surface = null;
  let rateStart = performance.now(), frames = 0, rate = null;
  $('.depth-gradient').style.background = `linear-gradient(to right, ${depthColors.map(color => `rgb(${color.join(',')})`).join(',')})`;

  function draw() {
    if (!frame) return;
    const { width, height } = frame.meta;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const [near, far] = $('#depth-range').value === 'auto' ? autoRange || [50, 1000] : $('#depth-range').value.split(',').map(Number);
    const enhanced = $('#depth-mode').value !== 'raw' && frame.filtered;
    const relief = Boolean(enhanced) && $('#depth-relief').getAttribute('aria-pressed') === 'true';
    $('#depth-relief').disabled = !enhanced;
    const scene = enhanced && $('#depth-mode').value === 'scene';
    const complete = enhanced && $('#depth-mode').value === 'complete';
    if (complete && !completed) completed = fillDepthHoles(frame.filtered, width, height, frame.meta.depth_scale_m);
    if (scene && !surface) surface = fillSurfaceHoles(frame.filtered, width, height, frame.meta.depth_scale_m);
    const displayPixels = scene ? surface.pixels : complete ? completed.pixels : enhanced ? frame.filtered : frame.pixels;
    $('#depth-near').textContent = `${near} mm`; $('#depth-far').textContent = `${far} mm`;
    if (!background) background = new ImageData(colorizeDepth({ ...frame, pixels: displayPixels }, near, far, { shade: relief }), width, height);
    context.putImageData(background, 0, 0);
  }
  function lost(status) {
    const condition = health.check(status, performance.now());
    if (condition.resetCursor) after = 0;
    const text = ({ missing: '未检测到 D405，请检查 USB 连接', unsupported: '深度采集组件未安装',
      disabled: '服务器尚未启用深度采集', unavailable: '深度相机暂时无法读取，正在重试' })[status] || '正在等待新的深度帧…';
    if (condition.hasFrame) {
      if (!condition.paused) return;
      badge.textContent = '画面暂停'; badge.title = `${text}；当前保留上一帧，正在自动重连`;
      section.dataset.stale = 'true'; image.dataset.paused = 'true';
      freeze.disabled = true;
      rateStart = performance.now(); frames = 0;
      $('#depth-details').textContent = `${frame.meta.width} × ${frame.meta.height} · 已暂停`;
    } else {
      freeze.disabled = true; download.disabled = true; badge.textContent = status === 'missing' ? '未连接' : '等待深度';
      message.textContent = text; message.hidden = false;
    }
  }
  async function poll() {
    const started = performance.now();
    let delay = 0;
    try {
      if (frozen || document.hidden || panel.closest('.work-page')?.hidden) return;
      const response = await fetch(`/api/depth?after=${after}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!active || frozen) return;
      if (response.status === 200) {
        const next = parseDepthPacket(await response.arrayBuffer());
        if (!active || frozen) return;
        frame = next; background = null; completed = null; surface = null; after = frame.meta.stamp;
        const estimate = frame.meta.suggested_range_mm;
        if (Array.isArray(estimate) && estimate.length === 2 && estimate.every(Number.isFinite) && estimate[1] > estimate[0]) {
          autoRange = autoRange ? autoRange.map((value, i) => value * .88 + estimate[i] * .12) : estimate;
          autoRange = autoRange.map(Math.round);
        }
        canvas.hidden = false; message.hidden = true; freeze.disabled = false; download.disabled = false;
        const now = performance.now(); frames++;
        health.received(now); section.dataset.stale = 'false'; image.dataset.paused = 'false'; badge.title = '';
        if (now - rateStart > 1000) { rate = Math.round(frames * 1000 / (now - rateStart)); frames = 0; rateStart = now; }
        badge.textContent = '实时深度';
        $('#depth-details').textContent = `${frame.meta.width} × ${frame.meta.height}${rate === null ? '' : ` · ${rate} fps`}`;
        draw();
      } else if (response.status === 204) {
        const status = response.headers.get('X-Camera-State');
        lost(status);
        if (status !== 'live' && status !== 'waiting') delay = 700;
      } else { lost(response.status === 404 ? 'disabled' : 'unavailable'); delay = 1000; }
    } catch { if (!frozen) lost('unavailable'); delay = 700; }
    finally { if (active) setTimeout(poll, frozen || document.hidden ? 500 : Math.max(delay, 1000 / 15 - (performance.now() - started))); }
  }
  $('#depth-range').onchange = () => { background = null; draw(); };
  $('#depth-mode').onchange = () => { background = null; draw(); };
  $('#depth-relief').onclick = () => {
    const button = $('#depth-relief');
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    background = null; draw();
  };
  $('#depth-fullscreen').onclick = () => image.requestFullscreen();
  $('.depth-exit').onclick = event => { event.stopPropagation(); document.exitFullscreen(); };
  freeze.onclick = () => {
    frozen = !frozen; freeze.textContent = frozen ? '恢复实时' : '冻结';
    image.dataset.frozen = String(frozen);
    section.dataset.frozen = String(frozen);
    badge.textContent = frozen ? '已冻结' : '等待新帧';
    draw();
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
  poll();
}

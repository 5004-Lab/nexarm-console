import { FrameHealth } from './frame-health.js';

const messages = {
  searching: '正在查找机械臂 USB 相机…',
  missing: '未检测到机械臂 USB 相机',
  permission: '请在 macOS「隐私与安全性 → 相机」允许 NexArm Camera 访问',
  unsupported: '相机采集组件未就绪',
  unavailable: '相机暂时无法读取，正在重试',
  waiting: '正在等待实时画面…',
};

export function createCamera(panel, onPose, onFrame = () => {}, { endpoint = '/api/camera', syncPose = true, name = '机械臂 USB 相机' } = {}) {
  const canvas = panel.querySelector('canvas');
  const context = canvas.getContext('2d');
  const message = panel.querySelector('.camera-message');
  const badge = panel.querySelector('.camera-status');
  const details = panel.querySelector('.camera-details');
  const presented = [];
  let capture = 0;
  let active = true;
  let deadline = 0;
  let paired = false;
  let lastBlob;
  let lastSize = '';
  const health = new FrameHealth();
  const full = panel.querySelector('[data-camera-fullscreen]');
  const download = panel.querySelector('[data-camera-download]');
  if (full) full.onclick = () => panel.querySelector('.camera-image').requestFullscreen();
  if (download) download.onclick = () => {
    if (!lastBlob) return;
    const url = URL.createObjectURL(lastBlob);
    Object.assign(document.createElement('a'), { href: url, download: `nexarm-${panel.id}-${Date.now()}.jpg` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  function status(label, text = '') {
    badge.textContent = label;
    message.hidden = !text;
    if (text) message.textContent = text;
  }

  function lost(state) {
    paired = false;
    deadline = 0;
    const text = state === 'missing' ? `未检测到${name}` : state === 'searching' ? `正在查找${name}…` : messages[state] || messages.unavailable;
    const condition = health.check(state, performance.now());
    if (condition.resetCursor) capture = 0;
    if (condition.hasFrame) {
      if (!condition.paused) return;
      presented.length = 0;
      status('画面暂停');
      badge.title = `${text}；当前保留上一帧，正在自动重连`;
      panel.dataset.stale = 'true';
      panel.querySelector('.camera-image').dataset.paused = 'true';
      details.textContent = `${lastSize} · 已暂停`;
    } else {
      status(state === 'missing' ? '未连接' : '等待画面', text);
      details.hidden = true;
    }
  }

  async function poll() {
    const started = performance.now();
    let delay = 0;
    try {
      if (document.hidden || panel.closest('.work-page')?.hidden) { delay = 500; return; }
      const response = await fetch(`${endpoint}?after=${capture}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!active) return;
      const mode = response.headers.get('X-Camera-State');
      if (response.status === 200) {
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        try {
          if (!active) return;
          const pose = JSON.parse(response.headers.get('X-Camera-Pose') || 'null');
          const skew = response.headers.get('X-Pose-Skew');
          capture = Number(response.headers.get('X-Camera-Time'));
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          context.drawImage(bitmap, 0, 0);
          lastBlob = blob;
          canvas.hidden = false;
          paired = syncPose && Array.isArray(pose) && pose.length === 6;
          const now = performance.now();
          health.received(now);
          panel.dataset.stale = 'false';
          panel.querySelector('.camera-image').dataset.paused = 'false';
          presented.push(now);
          while (presented[0] < now - 1000) presented.shift();
          const size = `${bitmap.width} × ${bitmap.height}`;
          lastSize = size;
          const elapsed = now - presented[0];
          const rate = elapsed >= 500 ? Math.round((presented.length - 1) * 1000 / elapsed) : null;
          details.textContent = rate === null ? size : `${size} · ${rate} fps`;
          details.hidden = false;
          deadline = now + 480;
          if (paired) onPose(pose);
          onFrame({ stamp: capture, skew: paired ? Number(skew) : null, width: bitmap.width, height: bitmap.height, rate });
          status(paired ? `同步 · ${skew} ms` : syncPose ? '实时画面 · 等待关节反馈' : '实时画面');
          badge.title = '';
        } finally {
          bitmap.close();
        }
      } else {
        lost(mode);
        if (mode !== 'live' && mode !== 'waiting') delay = 650;
      }
    } catch {
      lost('unavailable');
      delay = 300;
    } finally {
      if (active) setTimeout(poll, document.hidden ? 500 : Math.max(delay, 1000 / 15 - (performance.now() - started)));
    }
  }
  function start() {
    active = true;
    poll();
  }
  window.addEventListener('pagehide', () => {
    active = false;
    paired = false;
  });
  window.addEventListener('pageshow', event => { if (event.persisted && !active) start(); });
  poll();
  return { paired: () => paired && performance.now() < deadline };
}

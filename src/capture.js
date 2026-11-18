import { chart } from './telemetry.js';

export const capturePage = `
  <div class="page-heading"><h1>实验数据采集</h1><span>动作组回放 · RGB / 状态 / 动作 / 指令</span></div>
  <div class="capture-grid">
    <section class="panel">
      <header class="panel-header"><h2>采集配置</h2><span id="capture-frame-count" class="chart-unit">动作组 0 帧</span></header>
      <form id="capture-form" class="capture-form">
        <label>任务指令<textarea id="capture-prompt" rows="2" maxlength="240" required placeholder="例如：抓取蓝色方块并放入托盘"></textarea></label>
        <div class="capture-fields">
          <label>回合次数<input id="capture-loops" type="number" min="1" max="50" value="3" required></label>
          <label>采样频率<select id="capture-fps"><option value="5">5 Hz</option><option value="8">8 Hz</option><option value="10">10 Hz</option></select></label>
        </div>
        <label class="capture-option"><input id="capture-auto-export" type="checkbox" checked disabled> 采集完成后生成 LeRobot v3</label>
        <div class="capture-actions"><button type="submit" class="primary-button" id="capture-start" disabled>开始重复采集</button>
          <button type="button" class="danger-button" id="capture-stop" disabled>停止采集</button><a href="#actions">编辑动作组</a></div>
        <p class="field-hint">首帧作为每回合的准备姿态，从第二帧开始记录。请在开始前布置好可重复运行的工位。</p>
      </form>
    </section>
    <section class="panel">
      <header class="panel-header"><h2>实时数据流</h2><span class="status-label" id="capture-phase">待采集</span></header>
      <dl class="data-flow">
        <div><dt>腕部 RGB</dt><dd id="stream-rgb">—</dd><small>observation.images.wrist</small></div>
        <div><dt>编码器反馈</dt><dd id="stream-joints">—</dd><small>observation.state · 6 维</small></div>
        <div><dt>绝对角度指令</dt><dd id="stream-action">—</dd><small>action · 6 维</small></div>
        <div><dt>时间匹配</dt><dd id="stream-skew">—</dd><small>主机单调时钟</small></div>
      </dl>
      <div class="capture-summary">
        <div class="capture-counts"><span>回合 <output id="capture-progress">—</output></span>
          <span>完整 <output id="capture-saved">0</output></span><span>配对帧 <output id="capture-samples">0</output></span>
          <span>丢帧 <output id="capture-dropped">0</output></span></div>
        <p id="capture-message" role="status">启用控制并准备腕部相机后开始。</p>
        <div class="capture-actions"><a id="capture-raw" hidden>下载 RGB / JSONL</a><button type="button" id="capture-export" disabled>生成 LeRobot v3</button><a id="capture-lerobot" hidden>下载 LeRobot v3</a></div>
      </div>
    </section>
  </div>
  <div class="chart-grid">${chart('sync')}${chart('error')}</div>
  <section class="panel capture-library">
    <header class="panel-header"><h2>采集记录</h2></header>
    <div class="capture-table"><table><thead><tr><th>任务指令</th><th>采样频率</th><th>完整回合</th><th>下载</th></tr></thead>
      <tbody id="capture-library"><tr><td colspan="4">暂无已打包的数据</td></tr></tbody></table></div>
  </section>`;

const $ = selector => document.querySelector(selector);
const phases = { idle: '待采集', recording: '正在采集', packing: '打包中', ready: '打包完成', exporting: '正在导出', error: '采集失败' };

export function createCapture(api, canMove, getFrames, readOnly) {
  let capture = {};
  let pending = false;
  let libraryState;
  let recentCamera;
  let lastState = {};

  function frame(frameData) {
    recentCamera = { ...frameData, seen: performance.now() };
  }

  function render(state = lastState) {
    lastState = state;
    const frames = getFrames().length;
    const camera = recentCamera && performance.now() - recentCamera.seen < 850 ? recentCamera : null;
    const running = capture.phase === 'recording';
    const active = ['recording', 'packing', 'exporting'].includes(capture.phase);
    const output = (id, value) => { $(`#${id}`).textContent = value; };
    output('capture-frame-count', `动作组 ${frames} 帧`);
    output('stream-rgb', camera ? `${camera.width} × ${camera.height}` : '等待画面');
    output('stream-joints', state.connected ? `${state.hz} Hz` : '等待反馈');
    output('stream-action', state.action_angles ? '六轴可用' : '等待指令');
    output('stream-skew', camera?.skew != null ? `${camera.skew} ms` : '等待对齐');
    output('capture-phase', phases[capture.phase] || (readOnly() ? '查看模式' : '待采集'));
    output('capture-progress', capture.requested ? `${capture.episode} / ${capture.requested}` : '—');
    output('capture-saved', capture.saved ?? 0);
    output('capture-samples', capture.frames ?? 0);
    output('capture-dropped', capture.dropped ?? 0);
    output('capture-message', capture.export_error || capture.message || (running ? '正在按主机时间戳配对采样' :
      active ? phases[capture.phase] : '启用控制并准备腕部相机后开始。'));
    $('#capture-start').disabled = pending || active || !camera || frames < 2 || !canMove();
    $('#capture-stop').disabled = pending || !running || !state.armed;
    $('#capture-export').disabled = pending || capture.phase !== 'ready' || !capture.lerobot_available || Boolean(capture.lerobot);
    $('#capture-auto-export').disabled = active || !capture.lerobot_available;
    $('#capture-export').title = capture.lerobot_available ? '' : '请配置 LeRobot 导出环境';
    for (const [id, url] of [['capture-raw', capture.archive], ['capture-lerobot', capture.lerobot]]) {
      const link = $(`#${id}`);
      link.hidden = !url;
      if (url) link.href = url;
    }
  }

  async function run(action, data) {
    pending = true;
    render();
    try {
      const result = await api(action, data);
      if (result.phase) capture = result;
      await refresh();
    } catch (error) {
      capture = { ...capture, message: error.message };
    } finally {
      pending = false;
      render();
    }
  }
  async function refresh() {
    if (readOnly() || $('#page-capture').hidden) return;
    try {
      const response = await fetch('/api/capture-state', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        capture = await response.json();
        const stamp = `${capture.id}:${capture.phase}`;
        if (stamp !== libraryState) await loadLibrary(stamp);
      }
    } catch { /* State polling can retry on the next interval. */ }
    render();
  }
  async function loadLibrary(stamp) {
    const response = await fetch('/api/capture-library', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return;
    const { runs } = await response.json();
    const table = $('#capture-library');
    table.replaceChildren();
    if (!runs.length) {
      const cell = table.insertRow().insertCell();
      cell.colSpan = 4;
      cell.textContent = '暂无已打包的数据';
    }
    for (const run of runs) {
      const row = table.insertRow();
      for (const value of [run.task, `${run.fps} Hz`, run.episodes]) row.insertCell().textContent = value;
      const downloads = row.insertCell();
      for (const [title, url] of [['原始数据', run.archive], ['LeRobot v3', run.lerobot]]) {
        if (!url) continue;
        const link = document.createElement('a');
        link.textContent = title;
        link.href = url;
        downloads.append(link);
      }
    }
    libraryState = stamp;
  }
  $('#capture-form').onsubmit = event => {
    event.preventDefault();
    if ($('#capture-start').disabled || !canMove()) return;
    run('capture-start', {
      prompt: $('#capture-prompt').value, loops: $('#capture-loops').valueAsNumber,
      fps: Number($('#capture-fps').value), frames: getFrames(),
      export_v3: !$('#capture-auto-export').disabled && $('#capture-auto-export').checked,
    });
  };
  $('#capture-stop').onclick = () => run('stop', {});
  $('#capture-export').onclick = () => run('capture-export', { id: capture.id });
  setInterval(refresh, 550);
  return { render, frame, refresh };
}

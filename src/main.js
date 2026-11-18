import './styles.css';
import joints from './joints.json';
import { createTwin } from './twin.js';
import { createCamera } from './camera.js';
import { createWorkspace } from './workspace.js';
import { chart, createTelemetry, jointRangeTable } from './telemetry.js';
import { capturePage, createCapture } from './capture.js';
import workcell from './workcell.json';
import { jointAngle, jointPosition, angleSpeed } from './joint-units.js';
import bot from 'lucide-static/icons/bot.svg?raw';
import rotate from 'lucide-static/icons/rotate-ccw.svg?raw';
import lock from 'lucide-static/icons/lock.svg?raw';
import cameraIcon from 'lucide-static/icons/video.svg?raw';

const $ = selector => document.querySelector(selector);
function operatorId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
const headers = { 'X-Operator': operatorId() };
const storage = 'nexarm-action-group-v2';
const minJogSpeed = 75;
const maxJogSpeed = 210;
const draft = joints.map(() => ({ pos: 2048, acc: 100, speed: maxJogSpeed }));
let state = {};
let key;
let frames = [];
let selected = -1;
let initialized = false;
let readAfter = null;
let servoDraft = false;
let busy = false;
let armedLocally = false;
let lastResult;
let active = true;
let modelReady = false;
let modelError = '';
const jogTimers = new Map();

function asInt(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${name}须为 ${min}–${max} 的整数`);
  return value;
}

function parseFrames(raw) {
  if (!Array.isArray(raw) || raw.length > 255) throw Error('动作组格式无效，最多支持 255 帧');
  return raw.map((item, index) => {
    const time = asInt(item?.time ?? 1000, 10, 10000, `第 ${index + 1} 帧时间`);
    const source = Array.isArray(item) ? item : item?.servos;
    if (!Array.isArray(source) || source.length !== 6) throw Error(`第 ${index + 1} 帧需要六个舵机位置`);
    const servos = source.map((s, i) => ({
      pos: asInt(typeof s === 'number' ? s : s?.pos, 0, 4095, `S${i + 1} 位置`),
      acc: asInt(s?.acc ?? 0, 0, 255, `S${i + 1} Acc`),
    }));
    return { time, servos };
  });
}

try {
  const saved = localStorage.getItem(storage);
  if (saved) frames = parseFrames(JSON.parse(saved));
  else {
    const old = JSON.parse(localStorage.getItem('nexarm-poses-v1') || '[]');
    frames = parseFrames(old.map(p => ({ time: p.duration, servos: p.positions.map(pos => ({ pos, acc: 100 })) })));
  }
} catch { /* The editor starts empty if its previous draft cannot be read. */ }

$('#app').innerHTML = `
<header class="app-bar">
  <a class="brand" href="#control" aria-label="NexArm 机械臂实验台"><span>${bot}</span><b>NexArm</b><i></i><small>机械臂实验台</small></a>
  <div class="status-items"><span id="link" class="connection"><i></i><span>等待连接</span></span><span id="voltage" class="metric">— V</span><span id="firmware" class="metric">—</span>
  <button id="arm" class="arm-button" type="button" disabled>${lock}<span>启用控制</span></button><button id="motion-stop" class="danger-button" type="button" disabled>停止</button></div>
</header>
<nav class="page-nav" aria-label="工作台页面">
  <a href="#control">机械臂控制</a><a href="#telemetry">运动遥测</a><a href="#capture">数据采集</a><a href="#actions">动作组与调试</a>
</nav>
<main class="workspace">
  <div class="work-page" id="page-control">
  <div class="page-heading"><h1>机械臂控制</h1><span>基座坐标系 · mm / °</span></div>
  <section class="visuals" aria-label="并列监控">
    <section class="view-panel panel" aria-label="数字孪生">
      <header class="panel-header">
        <div class="panel-title"><h2>数字孪生</h2><span id="twin-status" class="status-label">加载模型</span></div>
        <div class="views" aria-label="观察视角">
          <button type="button" data-view="iso" aria-pressed="true">三维</button><button type="button" data-view="front" aria-pressed="false">正视</button><button type="button" data-view="top" aria-pressed="false">俯视</button>
          <button id="reset-view" type="button" aria-label="重置视角" title="重置视角">${rotate}</button>
        </div>
      </header>
      <div class="viewer visual-frame">
        <div id="canvas-host"></div><span id="model-note" class="model-note">正在载入 NexArm 模型</span>
      </div>
      <footer class="view-footer"><span><span class="legend-dot"></span> 末端 <span class="legend-dot target-dot"></span> 目标</span><span id="rate">等待六轴反馈</span></footer>
    </section>
    <section class="camera-panel panel" aria-label="腕部彩色视频">
      <header class="panel-header">
        <div class="panel-title"><h2>${cameraIcon} 腕部 RGB 相机</h2></div>
        <output class="camera-status status-label" title="视频帧与匹配六轴反馈的时间差">等待画面</output>
      </header>
      <div class="camera-image visual-frame" id="wrist-camera-image"><canvas hidden aria-label="末端相机实时画面"></canvas><p class="camera-message">正在查找机械臂 USB 相机…</p></div>
      <footer class="view-footer"><span>腕部视角</span><span class="camera-details" hidden></span></footer>
    </section>
  </section>
  <div class="analysis-layout">
    <section class="coordinate-panel panel" aria-labelledby="coordinate-title">
      <header class="panel-header"><div class="panel-title"><h2 id="coordinate-title">末端与关节控制</h2></div><div class="views"><button id="take-tcp" type="button">取当前位置</button><button id="park" type="button" class="park-button" disabled>${rotate} 复位</button></div></header>
      <div class="coordinate-content">
        <div class="current-tcp"><span>当前末端</span><output id="tcp-reading">—</output></div>
        <form id="target-form">
          <div class="coordinates">${['X', 'Y', 'Z'].map(axis => `<label for="target-${axis}"><span>${axis}</span><input id="target-${axis}" type="number" min="${axis === 'Z' ? workcell.floor_mm + 5.1 : -workcell.max_reach_mm}" max="${workcell.max_reach_mm}" step="any" required aria-label="${axis} 目标坐标（毫米）" /></label>`).join('')}</div>
          <div class="coordinate-actions"><button id="pick-target" type="button" aria-pressed="false" title="使用当前 Z 在模型上选 XY">图上选点</button><button id="preview-target" type="submit">检查路径</button><button id="move-target" class="primary-button" type="button" disabled>移动到目标</button></div>
        </form>
        <p id="plan-notice" class="plan-notice" role="status" aria-live="polite"></p>
        <p id="notice" class="notice" role="status" aria-live="polite"></p>
      </div>
      <form class="manual-form" id="joint-target-form">
        <div class="manual-heading"><h3>关节控制</h3><span>目标角度 (°)</span><button id="read-joint-targets" type="button">取实测</button></div>
        <div class="manual-inputs" aria-label="六轴目标角度">${joints.map((joint, i) => `<label title="${joint.name}"><span>J${i + 1}</span><input type="number" min="-360" max="360" step="0.01" id="manual-${i}" placeholder="—" aria-label="J${i + 1} 目标角度（度）" /></label>`).join('')}</div>
        <div class="manual-footer"><span id="manual-state" role="status"></span><button id="move-joints" class="primary-button" type="submit" disabled>移动关节</button></div>
      </form>
    </section>
    ${chart('angle')}
    ${jointRangeTable()}
  </div>
  </div>
  <div class="work-page" id="page-telemetry" hidden>
    <div class="page-heading"><h1>运动遥测</h1><span>编码器实测 · 速度和加速度由角度差分</span></div>
    <div class="chart-grid telemetry-grid">${['angle', 'speed', 'acceleration', 'tcp', 'gripper', 'error'].map(signal => chart(signal)).join('')}</div>
    <div class="chart-grid geometry-grid">${chart('range')}${chart('workspace')}</div>
  </div>
  <div class="work-page" id="page-capture" hidden>${capturePage}</div>
  <div class="work-page" id="page-actions" hidden>
    <div class="page-heading"><h1>动作组与调试</h1><span>单轴点动 · 动作序列 · 串口日志</span></div>
    <p id="action-notice" class="notice" role="status"></p>
  <section class="advanced panel">
    <div class="advanced-layout">
      <section class="left-pane">
        <div class="quick-actions">
          <button id="home" type="button">复位</button><button id="on-all" type="button">全部上电</button>
          <button id="off-all" type="button">全部掉电</button><button id="read" type="button">读取位置</button><button id="calibrate" type="button">校准中位</button>
        </div>

      <div id="servo-cards" class="servo-cards">${joints.map((joint, i) => `
        <article class="servo-card" data-servo="${i}">
          <header><h2>ID: ${i + 1}</h2><span>${joint.name}</span><button type="button" class="torque" title="扭矩按钮显示本次会话发送的状态" aria-label="ID ${i + 1} 扭矩">—</button></header>
          <div class="servo-fields">
            <label for="pos-${i}">目标 °</label><input id="pos-${i}" data-field="pos" type="number" step="0.01" value="0" />
            <span>实测</span><output class="angle" title="控制器回传的实际角度">—</output>
            <label for="acc-${i}">Acc</label><input id="acc-${i}" data-field="acc" type="number" min="0" max="255" value="100" />
            <label for="speed-${i}" title="单轴移动的速度上限">°/s</label><input id="speed-${i}" data-field="speed" type="number" step="0.01" aria-label="J${i + 1} 单轴速度（度每秒）" />
          </div>
          <button class="jog-button" type="button">移动 J${i + 1}</button>
        </article>`).join('')}</div>
    <div class="logs">
      <section class="log-panel" data-log="hex" aria-labelledby="hex-title"><header><h2 id="hex-title">HEX 数据流 (RX/TX)</h2><button type="button" data-log-action="clear">一键清除</button><button type="button" data-log-action="export">一键导出</button></header><pre tabindex="0" aria-label="HEX 数据流"></pre></section>
      <section class="log-panel" data-log="text" aria-labelledby="log-title"><header><h2 id="log-title">系统日志 (Text)</h2><button type="button" data-log-action="clear">一键清除</button><button type="button" data-log-action="export">一键导出</button></header><pre tabindex="0" aria-label="系统日志"></pre></section>
    </div>

      </section>
  <aside class="right-pane">
    <section aria-labelledby="action-title">
      <h2 class="section-title" id="action-title">动作组编辑</h2>
      <div class="table-shell">
        <table aria-label="动作帧"><thead><tr><th>#</th><th>时间</th>${joints.map((_, i) => `<th>S${i + 1}</th>`).join('')}</tr></thead><tbody id="frames"></tbody></table>
        <div class="empty" id="empty">暂无动作帧<br><small>到达目标后点击「添加」记录姿态</small></div>
      </div>
      <label class="field-row" for="frame-time"><span>本帧时间 (ms)</span><input id="frame-time" type="number" min="10" max="10000" step="10" value="1000" /></label>
      <p class="editor-note">动作组内可逐帧设置时间和各舵机 Acc。回放速度由关节角度变化和帧时间计算。</p>
      <div class="button-grid">
        <button id="add" type="button">添加</button><button id="update" type="button">更新</button>
        <button id="delete" type="button">删除</button><button id="clear" type="button">清空</button>
        <button id="up" type="button">上移</button><button id="down" type="button">下移</button>
        <button id="save" type="button">保存文件 (.d6a)</button><button id="load" type="button">载入文件</button>
        <input type="file" id="file" accept=".d6a,.json" hidden />
      </div>
      <p id="total">总运行时长: 0 ms</p>
    </section>
    <section class="run-pane" aria-labelledby="run-title">
      <h2 id="run-title" class="section-title">运行与下载</h2>
      <div class="online">
        <button id="run" type="button">电脑在线运行</button>
        <label for="loops">循环</label><input id="loops" type="number" min="0" max="9999" value="1" title="0 表示持续循环，直到停止" />
        <button id="stop" type="button" class="accent">停止</button>
      </div>
      <label class="field-row" for="group"><span>组 ID</span><input id="group" type="number" min="0" max="255" value="0" /></label>
      <div class="button-grid">
        <button id="download" type="button">下载</button><button id="board-run" type="button">运行 (板载)</button>
        <button id="erase" type="button">擦除</button><button id="board-stop" class="accent" type="button">停止</button>
      </div>
    </section>
  </aside>

    </div>
  </section>
  </div>
</main>`;

const cards = [...document.querySelectorAll('[data-servo]')];
const twin = createTwin($('#canvas-host'), message => {
  modelError = message;
  modelReady = !message;
  $('#model-note').hidden = !message;
  $('#model-note').textContent = message;
});

const telemetry = createTelemetry();
const capture = createCapture(api, () => liveControl() && !busy, () => frames, () => Boolean(state.remote_view));
const camera = createCamera($('.camera-panel'), feedback => twin.update(feedback), frame => {
  telemetry.camera(frame.stamp, frame.skew);
  capture.frame(frame);
});
const workspace = createWorkspace(twin, api, () => state, () => liveControl() && !busy);

function showPage() {
  const destinations = ['control', 'telemetry', 'capture', 'actions'];
  const requested = location.hash.slice(1);
  const activePage = destinations.includes(requested) ? requested : 'control';
  for (const destination of destinations) {
    const shown = destination === activePage;
    $(`#page-${destination}`).hidden = !shown;
    const link = $(`.page-nav a[href="#${destination}"]`);
    if (shown) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (activePage === 'capture') capture.refresh();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', showPage);
showPage();

function setView(view) {
  twin.view(view);
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
}
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => setView(button.dataset.view);
$('#reset-view').onclick = () => setView('iso');

function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const logViews = Object.fromEntries([...document.querySelectorAll('[data-log]')].map(panel => [
  panel.dataset.log, { panel, pre: panel.querySelector('pre'), lines: [], clearedAt: 0 },
]));
let cursor = 0;
function logLine(channel, time, line, record = null) {
  const view = logViews[channel];
  if (!view || (record !== null && record <= view.clearedAt)) return;
  view.lines.push(`[${time}] ${line}`);
  if (view.lines.length > 1400) view.lines.shift();
}
function paintLog(view) {
  const pinned = view.pre.scrollHeight - view.pre.scrollTop - view.pre.clientHeight < 45;
  view.pre.textContent = view.lines.join('\n');
  if (pinned) view.pre.scrollTop = view.pre.scrollHeight;
}
for (const [channel, view] of Object.entries(logViews)) {
  view.panel.querySelector('[data-log-action="clear"]').onclick = () => {
    view.lines = [];
    view.clearedAt = cursor;
    paintLog(view);
  };
  view.panel.querySelector('[data-log-action="export"]').onclick = () => download(`nexarm-${channel}.txt`, view.lines.join('\n'));
}
async function pollLogs() {
  try {
    const response = await fetch(`/api/logs?after=${cursor}`, { cache: 'no-store', signal: AbortSignal.timeout(1200) });
    if (!response.ok) return;
    const { cursor: next, entries } = await response.json();
    if (next < cursor) for (const view of Object.values(logViews)) view.clearedAt = 0;
    cursor = next;
    const updated = new Set();
    for (const [id, channel, time, line] of entries) {
      logLine(channel, time, line, id);
      updated.add(channel);
    }
    for (const channel of updated) if (logViews[channel]) paintLog(logViews[channel]);
  } catch { /* A serial viewer retains the previous logs during a service restart. */ }
  finally { if (active) setTimeout(pollLogs, 400); }
}
function notice(message, error = false, record = false) {
  $('#action-notice').textContent = message;
  $('#action-notice').classList.toggle('error', error);
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
  if (record) {
    logLine('text', new Date().toLocaleTimeString('zh-CN', { hour12: false }), message);
    paintLog(logViews.text);
  }
}

async function api(action, data = {}, retry = true) {
  if (!key) {
    const session = await fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (!session.ok) throw Error('无法连接本机控制服务');
    key = (await session.json()).key;
  }
  const response = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'X-Control-Key': key },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(['download', 'board-run', 'capture-start'].includes(action) ? 30000 : 5000),
  });
  if (response.status === 403 && retry) {
    key = null;
    return api(action, data, false);
  }
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '操作失败');
  return result;
}

function liveControl() {
  return state.connected && state.power_ok && state.armed && armedLocally && !state.task && !state.moving && state.board == null;
}

function cancelJog() {
  for (const timer of jogTimers.values()) clearTimeout(timer);
  jogTimers.clear();
}

async function perform(action, payload = {}, { interrupt = false } = {}) {
  if (busy && !interrupt) return;
  if (interrupt) cancelJog();
  busy = true;
  render();
  try {
    const result = await api(action, payload);
    if (action === 'arm') armedLocally = true;
    if (action === 'read') {
      readAfter = result.revision;
      notice('正在读取实测位置');
    }
    return result;
  } catch (error) {
    notice(error.message, true, true);
  } finally {
    busy = false;
    render();
  }
}

function posLimits(i) {
  return liveControl() ? state.limits[i] : [0, 4095];
}

function writeCard(i) {
  const card = cards[i];
  const [min, max] = posLimits(i);
  const position = card.querySelector('[data-field="pos"]');
  const span = [jointAngle(i, min), jointAngle(i, max)].sort((a, b) => a - b);
  position.min = span[0].toFixed(2);
  position.max = span[1].toFixed(2);
  const speed = card.querySelector('[data-field="speed"]');
  speed.min = angleSpeed(i, minJogSpeed).toFixed(2);
  speed.max = angleSpeed(i, maxJogSpeed).toFixed(2);
  for (const field of card.querySelectorAll('[data-field]')) {
    if (document.activeElement !== field) field.value = shownValue(i, field.dataset.field);
  }

}
function scheduleJog(i, wait = 72) {
  if (!liveControl() || jogTimers.has(i)) return;
  jogTimers.set(i, setTimeout(async () => {
    jogTimers.delete(i);
    if (!liveControl()) return;
    try {
      await api('jog', { device: i + 1, angle: Number(jointAngle(i, draft[i].pos).toFixed(2)), speed: draft[i].speed });
    } catch (error) {
      notice(error.message, true, true);
    }
  }, wait));
}
function shownValue(i, field) {
  const raw = draft[i][field];
  if (field === 'pos') return jointAngle(i, raw).toFixed(2);
  if (field === 'speed') return angleSpeed(i, raw).toFixed(2);
  return raw;
}

function changeAxis(i, field, value) {
  const ranges = { pos: posLimits(i), acc: [0, 255], speed: [minJogSpeed, maxJogSpeed] };
  if (!Number.isFinite(value)) return;
  const [min, max] = ranges[field];
  const raw = field === 'pos' ? jointPosition(i, value) : field === 'speed' ? value / angleSpeed(i, 1) : value;
  draft[i][field] = Math.max(min, Math.min(max, Math.round(raw)));
  servoDraft = true;
  writeCard(i);
}

for (const [i, card] of cards.entries()) {
  card.querySelector('.jog-button').onclick = () => scheduleJog(i, 0);
  for (const field of card.querySelectorAll('[data-field]')) {
    field.onchange = () => {
      changeAxis(i, field.dataset.field, field.valueAsNumber);
      field.value = shownValue(i, field.dataset.field);
    };
    field.onkeydown = event => {
      if (event.key === 'Enter') field.blur();
    };
  }
  card.querySelector('.torque').onclick = () => {
    const enabled = state.torque?.[i] !== true;
    if (!enabled && !confirm(`关闭 ID ${i + 1} 扭矩后，关节可能受重力移动。确认掉电？`)) return;
    perform('torque', { device: i + 1, enabled });
  };
}

function syncPositions() {
  if (!state.feedback) return;
  for (const [i, [position]] of state.feedback.entries()) draft[i].pos = position;
  servoDraft = false;
}
function frameFromCards() {
  return parseFrames([{ time: $('#frame-time').valueAsNumber, servos: draft.map(({ pos, acc }) => ({ pos, acc })) }])[0];
}
function showFrame(index, preview) {
  if (state.task || !frames[index]) return;
  cancelJog();
  selected = index;
  const frame = frames[index];
  $('#frame-time').value = frame.time;
  servoDraft = true;
  for (const [i, servo] of frame.servos.entries()) {
    Object.assign(draft[i], servo);
    const start = state.feedback?.[i][0] ?? servo.pos;
    draft[i].speed = Math.max(minJogSpeed, Math.min(maxJogSpeed, Math.floor(Math.abs(start - servo.pos) * 1200 / frame.time)));
  }
  paintFrames();
  render();
  if (preview && liveControl()) perform('run', { frames: [frame], loops: 1 });
}
function paintFrames() {
  $('#frames').replaceChildren(...frames.map((frame, i) => {
    const row = document.createElement('tr');
    row.dataset.frame = i;
    row.tabIndex = 0;
    row.classList.toggle('selected', selected === i);
    row.setAttribute('aria-selected', String(selected === i));
    row.innerHTML = `<td>${i + 1}</td><td>${frame.time}</td>${frame.servos.map((servo, j) => `<td>${jointAngle(j, servo.pos).toFixed(1)}°</td>`).join('')}`;
    row.onclick = () => showFrame(i, true);
    row.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showFrame(i, true);
      }
    };
    return row;
  }));
  $('#empty').hidden = frames.length !== 0;
  $('#total').textContent = `总运行时长: ${frames.reduce((sum, frame) => sum + frame.time, 0).toLocaleString('en-US')} ms`;
}
function saveDraft() {
  try { localStorage.setItem(storage, JSON.stringify(frames)); }
  catch { notice('当前浏览器无法保留草稿，可另存为 .d6a 文件', true, true); }
  paintFrames();
  render();
}
function edit(action) {
  if (state.task) return;
  try {
    if (action === 'add') {
      frames.push(frameFromCards());
      selected = frames.length - 1;
    } else if (action === 'update' && selected >= 0) frames[selected] = frameFromCards();
    else if (action === 'delete' && selected >= 0) {
      frames.splice(selected, 1);
      selected = Math.min(selected, frames.length - 1);
    } else if (action === 'clear') {
      frames = [];
      selected = -1;
    } else if (action === 'up' || action === 'down') {
      const next = selected + (action === 'up' ? -1 : 1);
      if (selected >= 0 && next >= 0 && next < frames.length) {
        [frames[selected], frames[next]] = [frames[next], frames[selected]];
        selected = next;
      }
    }
    saveDraft();
  } catch (error) { notice(error.message, true, true); }
}
for (const action of ['add', 'update', 'delete', 'clear', 'up', 'down']) $(`#${action}`).onclick = () => edit(action);

$('#save').onclick = () => download('NexArm-动作组.d6a', JSON.stringify(frames, null, 2), 'application/json');
$('#load').onclick = () => $('#file').click();
$('#file').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 524288) throw Error('动作组文件过大');
    const loaded = parseFrames(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
    if (state.task) throw Error('请等待当前运行结束后载入');
    frames = loaded;
    selected = -1;
    saveDraft();
    notice(`已载入 ${loaded.length} 帧 · ${file.name}`, false, true);
  } catch (error) { notice(`载入失败：${error.message}`, true, true); }
  finally { event.target.value = ''; }
};

$('#arm').onclick = () => {
  if (state.armed) {
    armedLocally = false;
    perform('disarm', {}, { interrupt: true });
  } else perform('arm');
};
$('#read').onclick = () => {
  cancelJog();
  perform('read');
};
$('#home').onclick = $('#park').onclick = async () => {
  const planned = await perform('park');
  if (planned) twin.setPath(planned.path);
};
$('#on-all').onclick = () => perform('torque', { enabled: true });
$('#off-all').onclick = () => {
  if (confirm('关闭全部舵机扭矩后，机械臂可能下落。支撑机械臂后确认掉电？')) perform('torque', { enabled: false }, { interrupt: true });
};
$('#calibrate').onclick = () => {
  if (confirm('确认将 ID 1–4 的当前位置写为安装中位？此操作会修改舵机校准。')) perform('calibrate');
};
$('#stop').onclick = () => perform('stop', {}, { interrupt: true });
$('#motion-stop').onclick = () => perform(state.board == null ? 'stop' : 'board-stop', {}, { interrupt: true });
$('#board-stop').onclick = () => perform('board-stop', {}, { interrupt: true });
$('#run').onclick = () => {
  try { perform('run', { frames, loops: asInt($('#loops').valueAsNumber, 0, 9999, '循环次数') }); }
  catch (error) { notice(error.message, true, true); }
};
for (const action of ['download', 'board-run', 'erase']) {
  $(`#${action}`).onclick = () => {
    try {
      const group = asInt($('#group').valueAsNumber, 0, 255, '组 ID');
      if (action === 'erase' && !confirm(`确认擦除控制器上的动作组 ${group}？`)) return;
      if (action === 'download' && !confirm(`确认写入板载组 ${group}？同组 ID 的原内容可能被覆盖。`)) return;
      perform(action, { group, frames });
    } catch (error) { notice(error.message, true, true); }
  };
}

function render() {
  const enabled = liveControl() && !busy;
  const maintenance = enabled && !state.remote_control;
  const editing = !state.task;
  $('#link').classList.toggle('online-link', Boolean(state.connected));
  $('#link span').textContent = state.connected ? 'USB 已连接' : '等待 USB';
  $('#voltage').textContent = state.voltage == null ? '— V' : `${state.voltage.toFixed(2)} V`;
  $('#voltage').title = state.bridge ? '切换运动通道前的实测电压' : '主控实测电压';
  $('#firmware').textContent = state.firmware ? `ESP32 ${state.firmware.esp}` : '—';
  $('#arm span').textContent = state.remote_view ? '仅查看' : state.armed ? '锁定控制' : state.operator_busy ? '控制被占用' : '启用控制';
  $('#arm').disabled = state.remote_view || busy || (!state.armed && (!state.connected || !state.power_ok || state.operator_busy));
  $('#arm').classList.toggle('engaged', Boolean(state.armed));
  $('#twin-status').textContent = modelError ? '模型加载失败' : !modelReady ? '加载模型' : state.connected ? '实测姿态' : initialized ? '反馈已暂停' : '等待反馈';
  $('#rate').textContent = state.connected ? `${state.hz} Hz · ${state.port?.replace('/dev/cu.', '')}` : '等待六轴反馈';
  for (const [i, card] of cards.entries()) {
    writeCard(i);
    card.querySelector('.angle').textContent = state.angles ? `${state.angles[i].toFixed(1)}°` : '—';
    const torque = state.torque?.[i];
    const button = card.querySelector('.torque');
    button.textContent = torque === true ? 'ON' : torque === false ? 'OFF' : '—';
    button.dataset.torque = String(torque);
    button.disabled = !maintenance;
    card.querySelector('.jog-button').disabled = !enabled;
    for (const field of card.querySelectorAll('input')) field.disabled = !editing || state.board != null;
  }
  const disable = (ids, condition) => {
    for (const id of ids) $(`#${id}`).disabled = condition;
  };
  disable(['on-all', 'off-all', 'calibrate', 'erase', 'board-run'], !maintenance);
  disable(['home', 'park'], !enabled);
  disable(['read'], state.remote_view || !state.connected);
  disable(['board-stop'], state.remote_view || state.remote_control || !state.connected);
  disable(['stop', 'motion-stop'], state.remote_view || !state.connected || (state.remote_control && state.board != null) ||
    (!state.armed && !state.task && !state.moving && state.board == null));
  workspace.update(state);
  telemetry.update(state);
  capture.render(state);
  disable(['run'], !enabled || !frames.length);
  disable(['download'], !maintenance || !frames.length);
  disable(['load', 'frame-time'], !editing);
  disable(['add'], !editing || frames.length >= 255);
  disable(['clear', 'save'], !frames.length || !editing);
  disable(['update', 'delete'], selected < 0 || !editing);
  disable(['up'], selected < 1 || !editing);
  disable(['down'], selected < 0 || selected >= frames.length - 1 || !editing);
  for (const row of $('#frames').children) {
    row.classList.toggle('running', state.task?.mode === 'run' && state.task.total === frames.length && Number(row.dataset.frame) + 1 === state.task.index);
  }
  if (state.task) {
    const { mode, index, total, loop } = state.task;
    notice(mode === 'run' ? `电脑在线运行 · 第 ${loop} 轮 · ${index}/${total} 帧` : `正在发送板载动作组 · ${index}/${total} 帧`);
  }
}

async function poll() {
  try {
    const response = await fetch('/api/state', { headers, cache: 'no-store', signal: AbortSignal.timeout(900) });
    if (!response.ok) throw Error('连接中断');
    const latest = await response.json();
    const disconnected = state.connected && !latest.connected;
    const disarmed = state.armed && !latest.armed;
    state = latest;
    if (disconnected || disarmed) {
      cancelJog();
      if (disarmed) armedLocally = false;
    }
    if (state.connected && state.feedback) {
      if (!camera.paired()) twin.update(state.feedback);
      if (!initialized || (readAfter !== null && state.revision > readAfter) || (!servoDraft && !state.task && !state.moving)) {
        syncPositions();
        if (readAfter !== null && state.revision > readAfter) {
          readAfter = null;
          notice('已读取六轴实际位置');
        }
        initialized = true;
      }
    }
    if (state.result && state.result !== lastResult) {
      notice(state.result, /中断|无效|失效|未到位|碰撞|跟踪偏差|未通过|超时|已停止/.test(state.result));
    }
    lastResult = state.result;
  } catch {
    if (initialized) notice('本机服务连接中断，实时控制已锁定', true);
    state = {};
    armedLocally = false;
    key = null;
    cancelJog();
  } finally {
    render();
    if (active) setTimeout(poll, document.hidden ? 320 : 85);
  }
}
setInterval(() => {
  if (active && armedLocally && state.armed && !document.hidden) api('heartbeat').catch(() => {
    armedLocally = false;
    cancelJog();
    render();
  });
}, 450);
function release() {
  cancelJog();
  if (!armedLocally || !key) return;
  armedLocally = false;
  fetch('/api/disarm', {
    method: 'POST', keepalive: true,
    headers: { ...headers, 'Content-Type': 'application/json', 'X-Control-Key': key },
    body: '{}',
  }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
window.addEventListener('pagehide', () => {
  active = false;
  release();
});
window.addEventListener('pageshow', event => {
  if (event.persisted && !active) {
    active = true;
    poll();
    pollLogs();
  }
});
paintFrames();
render();
poll();
pollLogs();

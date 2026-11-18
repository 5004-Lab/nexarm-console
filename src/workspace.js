import joints from './joints.json';

const colors = ['#0072bd', '#d95319', '#a16f00', '#7e2f8e', '#438719', '#18839b'];
const axes = ['X', 'Y', 'Z'];
const windowSeconds = 20;
const $ = selector => document.querySelector(selector);

export function createWorkspace(twin, api, getState, canMove) {
  const form = $('#target-form');
  const controls = axes.map(axis => $(`#target-${axis}`));
  const manualForm = $('#joint-target-form');
  const manualInputs = joints.map((_, i) => $(`#manual-${i}`));
  const edited = new Set();
  const planStatus = $('#plan-notice');
  const manualState = $('#manual-state');
  const pick = $('#pick-target');
  const go = $('#move-target');
  const jointGo = $('#move-joints');
  const canvas = $('#joint-chart');
  const ctx = canvas.getContext('2d');
  let working = false;
  let selecting = false;
  let hadPosition = false;
  let showingPhase = false;
  let revision = -1;
  const history = [];

  const curves = joints.map((joint, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = joint.name;
    button.setAttribute('aria-pressed', 'true');
    button.style.setProperty('--curve', colors[i]);
    button.innerHTML = `<i></i><span>J${i + 1}</span><output>—</output>`;
    $('#joint-legend').append(button);
    button.onclick = () => {
      const shown = button.getAttribute('aria-pressed') === 'true';
      if (shown && curves.filter(item => item.getAttribute('aria-pressed') === 'true').length === 1) return;
      button.setAttribute('aria-pressed', String(!shown));
      draw();
    };
    return button;
  });
  const outputs = curves.map(button => button.querySelector('output'));

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio, 2);
    const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
    if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) {
      canvas.width = pixels[0];
      canvas.height = pixels[1];
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const left = 54, top = 22, right = width - 14, bottom = height - 29;
    const tail = history.at(-1);
    const visible = curves.flatMap((button, i) => button.getAttribute('aria-pressed') === 'true' ? [i] : []);
    const samples = history.flatMap(sample => visible.map(i => sample.angles[i]));
    const min = samples.length ? Math.min(...samples) : 0;
    const max = samples.length ? Math.max(...samples) : 10;
    const stepSize = Math.max(1, (max - min) / 5);
    const unit = 10 ** Math.floor(Math.log10(stepSize));
    const step = unit * [1, 2, 2.5, 5, 10].find(n => n * unit >= stepSize);
    const low = Math.floor((min - step * 0.12) / step) * step;
    const high = Math.ceil((max + step * 0.12) / step) * step;

    for (const [i, output] of outputs.entries()) {
      const value = tail?.angles[i];
      output.textContent = value === undefined ? '—' : `${value.toFixed(1)}°`;
    }

    ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
    ctx.strokeStyle = '#e0e6ed';
    ctx.fillStyle = '#465565';
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.fillText('角度 (°)', left, 14);
    ctx.beginPath();
    for (let tick = 0; tick <= 4; tick++) {
      const x = left + (right - left) * tick / 4;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.textAlign = tick === 0 ? 'left' : tick === 4 ? 'right' : 'center';
      ctx.fillText(tick === 4 ? '0 s' : `${-windowSeconds + tick * 5}`, x, bottom + 16);
    }
    for (let value = low; value <= high + step * 0.001; value += step) {
      const y = bottom - (value - low) / (high - low) * (bottom - top);
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(value * 10) / 10), left - 5, y + 3);
    }
    ctx.stroke();
    ctx.strokeStyle = '#8795a5';
    ctx.strokeRect(left, top, right - left, bottom - top);
    if (!tail) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    for (const i of visible) {
      ctx.strokeStyle = ctx.fillStyle = colors[i];
      ctx.lineWidth = 1.45;
      ctx.beginPath();
      let x, y;
      for (const [index, sample] of history.entries()) {
        x = right + (sample.t - tail.t) / windowSeconds * (right - left);
        y = bottom - (sample.angles[i] - low) / (high - low) * (bottom - top);
        if (index === 0 || sample.t - history[index - 1].t > 0.65) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x - 1, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  new ResizeObserver(draw).observe(canvas);
  function values() {
    return controls.map(control => control.valueAsNumber);
  }

  function setNotice(text, type = '') {
    planStatus.textContent = text;
    planStatus.dataset.status = type;
  }

  function actionButtons() {
    const state = getState();
    go.disabled = working || !canMove() || !values().every(Number.isFinite);
    jointGo.disabled = working || !canMove() || edited.size === 0;
    $('#take-tcp').disabled = !state.connected;
    $('#read-joint-targets').disabled = !state.connected;
    $('#preview-target').disabled = state.remote_view || working || !state.connected;
    pick.disabled = Boolean(state.remote_view);
  }

  function clearPath() {
    twin.setPath([]);
    const xyz = values();
    twin.target(xyz.every(Number.isFinite) ? xyz : null);
    setNotice('');
    actionButtons();
  }

  function writeTarget(xyz) {
    controls.forEach((control, i) => { control.value = xyz[i].toFixed(1); });
    clearPath();
  }

  function pickMode(enabled) {
    selecting = enabled;
    pick.setAttribute('aria-pressed', String(enabled));
    pick.textContent = enabled ? '取消选点' : '图上选点';
    const height = controls[2].valueAsNumber;
    twin.pick(enabled && Number.isFinite(height) ? height : null, point => {
      pickMode(false);
      writeTarget(point);
      request(false);
    });
  }

  pick.onclick = () => {
    if (!selecting && !Number.isFinite(controls[2].valueAsNumber)) {
      setNotice('先输入选点平面的 Z 高度', 'error');
      controls[2].focus();
      return;
    }
    pickMode(!selecting);
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selecting) pickMode(false);
  });
  for (const control of controls) control.oninput = () => {
    clearPath();
    if (selecting) pickMode(Number.isFinite(controls[2].valueAsNumber));
  };
  $('#take-tcp').onclick = () => {
    const state = getState();
    if (state.connected && state.tcp) writeTarget(state.tcp);
  };

  function copyJoints() {
    const state = getState();
    if (!state.connected || !state.angles) return;
    edited.clear();
    for (const [i, input] of manualInputs.entries()) input.value = state.angles[i].toFixed(2);
    manualState.textContent = '';
    actionButtons();
  }
  $('#read-joint-targets').onclick = copyJoints;
  for (const [i, input] of manualInputs.entries()) input.oninput = () => {
    edited.add(i);
    manualState.textContent = '';
    actionButtons();
  };

  async function request(move) {
    if (working || getState().remote_view || (move && !canMove()) || !form.reportValidity()) return;
    const xyz = values();
    working = true;
    setNotice(move ? '正在校验并启动…' : '检查路径…');
    actionButtons();
    try {
      const solution = await api(move ? 'move-target' : 'preview-target', { xyz });
      if (values().some((value, i) => value !== xyz[i])) return;
      twin.setPath(solution.path);
      const order = solution.phases?.map(phase => phase.name).join(' → ');
      setNotice(move ? '' : order ? `路径通过 · ${order}` : '路径通过', 'pass');
    } catch (error) {
      twin.setPath([]);
      setNotice(error.message, 'error');
    } finally {
      working = false;
      actionButtons();
    }
  }

  form.onsubmit = event => { event.preventDefault(); request(false); };
  go.onclick = () => request(true);
  manualForm.onsubmit = async event => {
    event.preventDefault();
    if (working || !edited.size || !canMove() || !manualForm.reportValidity()) return;
    const angles = manualInputs.map((input, i) => edited.has(i) ? input.valueAsNumber : null);
    if (angles.some(value => value !== null && !Number.isFinite(value))) {
      manualState.textContent = '请输入有效角度';
      return;
    }
    working = true;
    actionButtons();
    try {
      await api('move-joints', { angles });
      edited.clear();
      manualState.textContent = '';
    } catch (error) {
      manualState.textContent = error.message;
    } finally {
      working = false;
      actionButtons();
    }
  };

  return {
    update(state) {
      actionButtons();
      if (state.motion_phase) {
        const { name, index, total } = state.motion_phase;
        const text = `第 ${index}/${total} 段 · ${name}`;
        if (planStatus.textContent !== text) setNotice(text);
        showingPhase = true;
      } else if (showingPhase) {
        setNotice('');
        showingPhase = false;
      }
      if (!state.connected || !state.angles || !state.tcp) {
        $('#tcp-reading').textContent = '—';
        return;
      }
      $('#tcp-reading').textContent = state.tcp.map((value, i) => `${axes[i]} ${value.toFixed(1)}`).join('   ');
      if (!hadPosition) {
        hadPosition = true;
        if (controls.every(control => !control.value)) writeTarget(state.tcp);
      }
      if (state.revision === revision) return;
      for (const [i, input] of manualInputs.entries()) {
        if (!edited.has(i) && document.activeElement !== input) input.value = state.angles[i].toFixed(2);
      }
      revision = state.revision;
      if (history.at(-1)?.t > revision) history.length = 0;
      history.push({ t: revision, angles: state.angles });
      while (history[0].t < revision - windowSeconds) history.shift();
      draw();
    },
  };
}

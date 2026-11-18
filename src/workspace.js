import joints from './joints.json';
import workcell from './workcell.json';
import { targetKey, nudgeTarget } from './target-space.js';

const axes = ['X', 'Y', 'Z'];
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
  let working = false;
  let selecting = false;
  let hadPosition = false;
  let showingPhase = false;
  let revision = -1;
  let validatedTarget = '';
  let targetRevision = 0;
  let pickOrigin;
  const insideWorkspace = ([x, y, z]) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
    z > workcell.floor_mm + 5 && Math.hypot(x, y, z) <= workcell.max_reach_mm;

  function values() {
    return controls.map(control => control.valueAsNumber);
  }

  function setNotice(text, type = '') {
    planStatus.textContent = text;
    planStatus.dataset.status = type;
  }

  function actionButtons() {
    const state = getState();
    go.disabled = working || selecting || !canMove() || !insideWorkspace(values()) || validatedTarget !== targetKey(values());
    jointGo.disabled = working || !canMove() || edited.size === 0;
    $('#take-tcp').disabled = !state.connected;
    $('#read-joint-targets').disabled = !state.connected;
    $('#preview-target').disabled = state.remote_view || working || !state.connected || !insideWorkspace(values());
    pick.disabled = state.remote_view || !state.connected || working;
    $('#target-confirm').disabled = working || !state.connected || state.remote_view || !insideWorkspace(values());
    for (const button of document.querySelectorAll('[data-target-nudge]')) button.disabled = working;
  }

  function clearPath() {
    targetRevision++;
    validatedTarget = '';
    twin.setPath([]);
    const xyz = values();
    twin.target(insideWorkspace(xyz) ? xyz : null);
    const outside = xyz.every(Number.isFinite) && !insideWorkspace(xyz);
    setNotice(outside ? '目标超出模型工作空间，请调整坐标' : '', outside ? 'error' : '');
    actionButtons();
    $('#target-preview-coordinates').textContent = values().map((value, i) => `${axes[i]} ${Number.isFinite(value) ? value.toFixed(1) : '—'}`).join('   ') + ' mm';
  }

  function writeTarget(xyz) {
    controls.forEach((control, i) => { control.value = xyz[i].toFixed(1); });
    clearPath();
  }

  function pickMode(enabled, restore = false) {
    selecting = enabled;
    pick.setAttribute('aria-pressed', String(enabled));
    pick.textContent = enabled ? '取消选点' : '三维选点';
    $('#target-editor').hidden = !enabled;
    if (enabled) {
      pickOrigin = controls.map(control => control.value);
      const measured = getState().tcp;
      const initial = insideWorkspace(values()) ? values() : measured && insideWorkspace(measured) ? measured : [150, 0, 120];
      writeTarget(initial);
      twin.pick(initial[2], candidates => {
        if (working || !selecting || !candidates.length) return;
        writeTarget(candidates[0]);
        setNotice(insideWorkspace(values()) ? '目标尚未确认。请从不同角度检查 XYZ，再确认并检查路径' : '目标超出模型工作空间，请调整 XYZ', insideWorkspace(values()) ? '' : 'error');
      }, initial);
      twin.targetSnap(Number($('#target-snap').value));
      setNotice('已进入三维编辑：拖动红 X、绿 Y、蓝 Z 箭头，或用毫米步长微调。确认后预检路径');
    } else {
      twin.pick(null);
      if (restore && pickOrigin) {
        controls.forEach((control, i) => { control.value = pickOrigin[i]; });
        clearPath();
      }
    }
    actionButtons();
  }

  pick.onclick = () => {
    pickMode(!selecting, selecting);
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selecting) pickMode(false, true);
  });
  for (const control of controls) control.oninput = () => {
    clearPath();
  };
  $('#target-cancel').onclick = () => pickMode(false, true);
  $('#target-confirm').onclick = () => request(false);
  $('#target-snap').onchange = event => twin.targetSnap(Number(event.target.value));
  for (const button of document.querySelectorAll('[data-target-nudge]')) button.onclick = () => {
    if (!selecting || working) return;
    const [axis, direction] = button.dataset.targetNudge.split(':');
    writeTarget(nudgeTarget(values(), axis, Number(direction), Number($('#target-snap').value)));
    setNotice('目标已调整，请确认 XYZ 并重新检查路径');
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
    if (working || getState().remote_view || (move && (!canMove() || selecting || validatedTarget !== targetKey(values()))) || !form.reportValidity()) return;
    const xyz = values();
    if (!insideWorkspace(xyz)) return;
    const requestRevision = targetRevision;
    working = true;
    setNotice(move ? '正在校验并启动…' : '检查路径…');
    actionButtons();
    try {
      const solution = await api(move ? 'move-target' : 'preview-target', { xyz });
      if (requestRevision !== targetRevision || values().some((value, i) => value !== xyz[i])) return;
      if (!move && selecting) pickMode(false);
      validatedTarget = targetKey(xyz);
      twin.setPath(solution.path);
      const order = solution.phases?.map(phase => phase.name).join(' → ');
      setNotice(move ? '运动已提交，等待实测到位' : order ? `六轴行程和路径通过模型检查 · ${order}` : '六轴行程和路径通过模型检查', 'pass');
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

    },
  };
}

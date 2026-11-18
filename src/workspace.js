import joints from './joints.json';
import workcell from './workcell.json';

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
    go.disabled = working || !canMove() || !insideWorkspace(values());
    jointGo.disabled = working || !canMove() || edited.size === 0;
    $('#take-tcp').disabled = !state.connected;
    $('#read-joint-targets').disabled = !state.connected;
    $('#preview-target').disabled = state.remote_view || working || !state.connected || !insideWorkspace(values());
    pick.disabled = state.remote_view || !state.connected || working;
  }

  function clearPath() {
    twin.setPath([]);
    const xyz = values();
    twin.target(insideWorkspace(xyz) ? xyz : null);
    const outside = xyz.every(Number.isFinite) && !insideWorkspace(xyz);
    setNotice(outside ? '目标超出模型工作空间，请调整坐标' : '', outside ? 'error' : '');
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
    const samples = twin.pick(enabled ? height : null, async candidates => {
      if (working) return;
      if (!candidates.length) {
        setNotice('请点击蓝色可达采样区域，或调整 Z 高度', 'error');
        return;
      }
      working = true;
      actionButtons();
      setNotice('按实测姿态检查选点…');
      try {
        for (const xyz of candidates.filter(insideWorkspace)) {
          try {
            const solution = await api('preview-target', { xyz });
            if (!selecting || controls[2].valueAsNumber !== xyz[2]) return;
            pickMode(false);
            writeTarget(xyz);
            twin.setPath(solution.path);
            setNotice('已选中可达目标。六轴行程和路径通过模型检查', 'pass');
            return;
          } catch { /* Nearby workspace samples can have an alternative safe solution. */ }
        }
        setNotice('这个位置的路径未通过检查，请换一个蓝点', 'error');
      } finally {
        working = false;
        actionButtons();
      }
    });
    if (enabled) setNotice(samples ? '点击蓝色工作空间采样点，系统将检查当前姿态的路径' : '此高度没有可达采样，请降低或调整 Z', samples ? '' : 'error');
  }

  pick.onclick = () => {
    if (!selecting && !insideWorkspace([0, 0, controls[2].valueAsNumber])) {
      setNotice('请输入工作空间内的 Z 高度', 'error');
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
    if (selecting) pickMode(insideWorkspace([0, 0, controls[2].valueAsNumber]));
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
    if (!insideWorkspace(xyz)) return;
    working = true;
    setNotice(move ? '正在校验并启动…' : '检查路径…');
    actionButtons();
    try {
      const solution = await api(move ? 'move-target' : 'preview-target', { xyz });
      if (values().some((value, i) => value !== xyz[i])) return;
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

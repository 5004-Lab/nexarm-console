export const historyToolbar = `<section class="history-toolbar" aria-label="操作记录工具栏">
  <strong>操作记录</strong><select id="history-session" aria-label="选择历史操作记录"><option>正在读取记录…</option></select>
  <button id="history-live" type="button">回到当前记录</button><button id="history-pause" type="button" aria-pressed="false">暂停跟随</button>
  <label>显示范围 <select id="history-window"><option value="0">完整过程</option><option value="30">最近 30 秒</option><option value="120">最近 2 分钟</option><option value="600">最近 10 分钟</option></select></label>
  <button id="history-json" type="button">导出轨迹 JSON</button><a id="history-zip">下载完整记录</a><output id="history-summary">等待记录</output>
</section>`;

export const observationForm = `<section class="observation-workbench" aria-labelledby="observation-title">
  <header class="section-heading"><div><h2 id="observation-title">双视角示教与场景采集</h2><p>同时记录腕部、第三人称、关节反馈和操作过程。开始记录后，可单独启用机械臂控制。</p></div><output id="observation-status">待记录</output></header>
  <form id="observation-form">
    <label>任务指令<input id="observation-task" required maxlength="240" placeholder="例如：用夹爪拿起螺丝刀，放到工具托盘"></label>
    <div class="observation-fields"><label>目标物体<input id="observation-objects" maxlength="240" placeholder="螺丝刀、方块…"></label><label>使用工具<input id="observation-tools" maxlength="240" placeholder="平行夹爪"></label><label>场景 / 布置<input id="observation-scene" maxlength="240" placeholder="桌面、光照、物体初始位置"></label><label>标定编号<input id="observation-calibration" maxlength="240" placeholder="未标定"></label></div>
    <div class="observation-actions"><button type="submit" id="observation-start" class="primary-button">开始双视角记录</button><button type="button" id="observation-stop">结束并保存</button><span>5 Hz · 原始采集尺寸 · 最长 20 分钟</span></div>
  </form>
  <div class="annotation-strip" aria-label="阶段与结果标注"><span>标注阶段</span>${['接近物体', '夹取', '提起', '搬运', '放置', '成功', '失败'].map(label => `<button type="button" data-observation-label="${label}">${label}</button>`).join('')}<output id="observation-message" role="status"></output></div>
</section>`;

const $ = selector => document.querySelector(selector);
export function createHistory(telemetry, twin, api, readOnly = () => false) {
  let sessions = [], current, selected, rows = [], events = [], cursor = 0, paused = false, loading = false, generation = 0;
  function status(active) {
    current = active?.id;
    $('#observation-status').textContent = active?.recording ? '正在记录双视角示教' : '待记录 · 操作轨迹持续保存';
    $('#observation-start').disabled = readOnly() || Boolean(active?.recording);
    $('#observation-stop').disabled = readOnly() || !active?.recording;
    for (const button of document.querySelectorAll('[data-observation-label]')) button.disabled = readOnly();
    if (active?.error) $('#observation-message').textContent = active.error;
  }
  function draw() {
    telemetry.load(rows, events);
    twin.setTrace(rows.filter(row => row.connected && row.tcp).map(row => row.tcp));
    const duration = rows.length > 1 ? rows.at(-1).stamp - rows[0].stamp : 0;
    $('#history-summary').textContent = `${rows.length} 个采样 · ${duration.toFixed(1)} s`;
    const table = $('#operation-events');
    table.replaceChildren();
    for (const event of events.slice(-100).reverse()) {
      const row = table.insertRow();
      row.insertCell().textContent = `${Math.max(0, event.stamp - (rows[0]?.stamp || event.stamp)).toFixed(2)} s`;
      row.insertCell().textContent = event.label;
    }
    if (!events.length) table.insertRow().insertCell().textContent = '此记录暂无阶段标注';
  }
  async function load() {
    if (loading || paused || !selected) return;
    loading = true;
    const token = generation;
    try {
      let more = true;
      while (more && token === generation) {
        const response = await fetch(`/api/history/samples?id=${selected}&after=${cursor}&limit=2000`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error('操作记录读取失败');
        const batch = await response.json();
        if (token !== generation) return;
        rows.push(...batch.samples); cursor = batch.cursor; events = batch.events; more = batch.more;
      }
      if (token === generation) draw();
    } catch (error) { $('#history-summary').textContent = error.message; }
    finally { loading = false; }
  }
  function choose(id) {
    generation++; selected = id; rows = []; events = []; cursor = 0;
    $('#history-session').value = id;
    $('#history-zip').href = `/api/history/archive?id=${id}`;
    load();
  }
  async function refresh() {
    try {
      const response = await fetch('/api/history/sessions', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!response.ok) return;
      const data = await response.json(); sessions = data.sessions; status(data.active);
      const selection = $('#history-session');
      if ([...selection.options].map(option => option.value).join() !== sessions.map(s => s.id).join()) {
        selection.replaceChildren(...sessions.map(session => new Option(`${new Date(session.created * 1000).toLocaleString('zh-CN', { hour12: false })} · ${session.metadata.task}${session.images ? ' · 双视角' : ''}`, session.id)));
        if (selected && sessions.some(s => s.id === selected)) selection.value = selected;
      }
      if (!selected) choose(current);
      await load();
    } catch { $('#history-summary').textContent = '记录服务连接中…'; }
  }
  $('#history-session').onchange = event => choose(event.target.value);
  $('#history-live').onclick = () => { paused = false; $('#history-pause').textContent = '暂停跟随'; $('#history-pause').setAttribute('aria-pressed', 'false'); choose(current); };
  $('#history-pause').onclick = event => { paused = !paused; event.target.textContent = paused ? '继续跟随' : '暂停跟随'; event.target.setAttribute('aria-pressed', String(paused)); if (!paused) load(); };
  $('#history-window').onchange = event => telemetry.window(Number(event.target.value));
  $('#history-json').onclick = () => {
    const blob = new Blob([JSON.stringify({ session: sessions.find(s => s.id === selected), samples: rows, events }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); Object.assign(document.createElement('a'), { href: url, download: `trajectory-${selected}.json` }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  async function record(action, data) {
    try { const active = await api(action, data); if (active.id) status(active); $('#observation-message').textContent = action === 'observation-mark' ? '阶段标注已保存' : action === 'observation-stop' ? '示教记录已保存，可从操作记录列表下载' : '双视角记录已开始'; await refresh(); if (action === 'observation-start') choose(current); }
    catch (error) { $('#observation-message').textContent = error.message; }
  }
  $('#observation-form').onsubmit = event => { event.preventDefault(); record('observation-start', Object.fromEntries(['task', 'objects', 'tools', 'scene', 'calibration'].map(key => [key, $(`#observation-${key}`).value]))); };
  $('#observation-stop').onclick = () => record('observation-stop', {});
  for (const button of document.querySelectorAll('[data-observation-label]')) button.onclick = () => record('observation-mark', { label: button.dataset.observationLabel });
  setInterval(refresh, 1500); refresh();
  return { refresh };
}

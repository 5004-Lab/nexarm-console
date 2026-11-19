export const historyToolbar = `<section class="history-toolbar" aria-label="操作记录工具栏">
  <strong>操作记录</strong><select id="history-session" aria-label="选择历史操作记录"><option>正在读取记录…</option></select>
  <button id="history-live" type="button">回到当前记录</button><button id="history-pause" type="button" aria-pressed="false">暂停跟随</button>
  <label>显示范围 <select id="history-window"><option value="0">完整过程</option><option value="30">最近 30 秒</option><option value="120">最近 2 分钟</option><option value="600">最近 10 分钟</option></select></label>
  <button id="history-json" type="button">导出轨迹 JSON</button><a id="history-zip">下载完整记录</a><output id="history-summary">等待记录</output>
</section>`;

const $ = selector => document.querySelector(selector);
export function createHistory(telemetry, twin) {
  let sessions = [], current, selected, rows = [], events = [], cursor = 0, paused = false, loading = false, generation = 0;
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
      const data = await response.json(); sessions = data.sessions; current = data.active?.id;
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
  setInterval(refresh, 1500); refresh();
  return { refresh };
}

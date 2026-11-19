import { colorizeDepth, parseDepthPacket } from './depth-data.js';

const rgb = ['front', 'wrist', 'third'];
const labels = { front: 'Front RGB', wrist: 'Wrist RGB', third: 'Third RGB', depth: 'D405 深度', feedback: '关节反馈', action: '下发指令' };
const results = { recording: '采集中', success: '成功', failure: '失败', unrated: '待评定', interrupted: '中断' };
const phases = ['接近', '夹取', '提起', '搬运', '放置', '撤离'];
const axes = ['J1', 'J2', 'J3', 'J4', 'J5', '夹爪'];
const resultOptions = Object.entries(results).filter(([value]) => value !== 'recording')
  .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

export const episodePage = `<section class="episode-workbench" aria-label="多模态示教">
  <header class="section-heading"><h2>多模态示教</h2><output id="episode-status" role="status">正在连接…</output></header>
  <form id="episode-record" class="episode-form">
    <label>任务指令<input name="task" required maxlength="240" placeholder="例如：把桌上的螺丝刀放进绿色盒子"></label>
    <div class="episode-fields">
      <label>目标物体<input name="objects" maxlength="240"></label>
      <label>场景<input name="scene" maxlength="240"></label>
      <label>标定编号<input name="calibration" maxlength="240"></label>
      <label>Front 相机<select name="front"><option value="d405">D405 RGB</option><option value="external">第三人称 RGB</option></select></label>
    </div>
    <div class="episode-actions"><button class="primary-button" id="episode-start">开始 Episode</button>
      <button type="button" id="episode-stop" disabled>结束并保存</button>
      <label>执行结果<select id="episode-result"><option value="unrated">待评定</option><option value="success">成功</option><option value="failure">失败</option></select></label>
      <a href="#control">进入机械臂控制</a><span>5 Hz · 三路 RGB + 原始深度 · 最长 20 分钟</span>
    </div>
  </form>
  <div class="annotation-strip" aria-label="Episode 阶段标注">${phases.map(label => `<button type="button" data-episode-phase="${label}" disabled>${label}</button>`).join('')}
    <input id="episode-label" maxlength="120" placeholder="自定义阶段" aria-label="自定义阶段"><button id="episode-mark" type="button" disabled>添加标注</button>
  </div>
  <output class="episode-message" id="episode-message" role="status"></output>
  <header class="section-heading"><h2>Episode 回放与清洗</h2><select id="episode-library" aria-label="选择 Episode"><option value="">正在加载…</option></select></header>
  <div id="episode-detail" hidden>
    <div class="episode-preview" aria-label="同步回放画面">${[...rgb, 'depth'].map(channel => `<figure>
      <figcaption>${labels[channel]} <span data-episode-source="${channel}"></span></figcaption>
      <div><canvas hidden role="img" aria-label="${labels[channel]} 回放"></canvas>
      <span data-episode-missing="${channel}">等待画面</span></div>
    </figure>`).join('')}</div>
    <div class="episode-actions episode-player">
      <button type="button" id="episode-play">播放</button><output id="episode-position"></output>
      <input id="episode-seek" type="range" min="0" value="0" aria-label="Episode 时间轴">
      <button type="button" id="episode-trim-start">设为起点</button><button type="button" id="episode-trim-end">设为终点</button>
    </div>
    <div class="episode-analysis">
      <section aria-label="实测与动作曲线">
        <header class="section-heading"><label>轨迹 <select id="episode-axis">${axes.map((label, i) => `<option value="${i}">${label}</option>`).join('')}</select></label>
          <span class="episode-legend"><b>实测</b><b>下发指令</b></span></header>
        <canvas id="episode-chart" role="img" aria-label="关节实测和下发指令曲线"></canvas>
        <table aria-label="当前帧实测与动作"><thead><tr><th>信号</th>${axes.map(axis => `<th>${axis}</th>`).join('')}</tr></thead>
          <tbody id="episode-values"></tbody></table>
        <output id="episode-sync"></output>
      </section>
      <section aria-label="阶段与质量"><header class="section-heading"><h2>阶段标注</h2></header><div id="episode-events"></div><output id="episode-quality"></output></section>
    </div>
    <form id="episode-review" class="episode-form">
      <div class="episode-fields"><label>训练任务<input name="task" required maxlength="240"></label>
        <label>结果<select name="result">${resultOptions}</select></label>
        <label>起始帧<input name="first" type="number" min="0" required></label>
        <label>结束帧<input name="last" type="number" min="0" required></label>
        <label>同步阈值 (ms)<input name="max_skew_ms" type="number" min="60" max="350" value="180" required></label>
        <label>最短连续帧数<input name="min_frames" type="number" min="2" max="300" value="5" required></label></div>
      <div class="episode-actions"><label><input name="third" type="checkbox">清洗要求 Third</label>
        <label><input name="depth" type="checkbox">清洗要求 Depth</label>
        <button class="primary-button" id="episode-prepare">清洗和计算归一化</button>
        <a id="episode-raw">下载原始包</a><a id="episode-training" hidden>下载训练包</a>
      </div>
      <output id="episode-review-status" role="status"></output>
      <details id="episode-normalization" hidden><summary>逐维归一化统计</summary><table><thead>
        <tr><th>信号</th><th>统计</th>${axes.map(axis => `<th>${axis}</th>`).join('')}</tr></thead><tbody></tbody></table></details>
    </form>
  </div>
</section>`;

const reasonNames = { trim: '裁剪范围外', no_action: '缺少下发指令', sensor_span: '模态间时差过大', short_clip: '连续片段过短', empty_depth: '深度无有效像素', feedback_spike: '孤立关节尖峰' };
function reasonText(key) {
  if (reasonNames[key]) return reasonNames[key];
  const [kind, signal] = key.split('_');
  return `${labels[signal] || signal}${{missing: '缺失', skew: '超时', repeat: '重复'}[kind] || key}`;
}

export function createEpisodes(api, readOnly, operator) {
  const $ = selector => document.querySelector(selector);
  const record = $('#episode-record'), review = $('#episode-review'), library = $('#episode-library');
  const play = $('#episode-play'), seek = $('#episode-seek'), chart = $('#episode-chart');
  const figures = Object.fromEntries([...document.querySelectorAll('.episode-preview figure')].map((figure, i) =>
    [[...rgb, 'depth'][i], { element: figure.querySelector('canvas'), message: figure.querySelector('[data-episode-missing]') }]));
  let active, detail, selected, decisions = new Map(), position = 0;
  let owned = sessionStorage.getItem('nexarm-episode-id');
  let loading = false, busy = false, playing = false, timer, mediaRequest, selectionRequest;
  let libraryVersion;

  const pageVisible = () => !$('#page-capture').hidden && !document.hidden;
  const endpoint = (kind, id, values = {}) => `/api/episodes/${kind}?${new URLSearchParams({id, ...values})}`;
  async function get(url, signal = AbortSignal.timeout(8000)) {
    const response = await fetch(url, {signal, cache: 'no-store'});
    if (!response.ok) throw Error('Episode 读取失败');
    return response;
  }

  function status(data) {
    active = data.active;
    const own = active && active.id === owned;
    const text = active ? `Episode ${active.episode_index} · ${active.samples} 帧 · ${active.valid} 帧通过基础检查` : data.error || '等待采集';
    $('#episode-status').textContent = text;
    $('#episode-indicator').hidden = !active;
    $('#episode-indicator').textContent = active ? `● Episode ${active.episode_index} · ${active.samples} 帧` : '';
    $('#episode-start').disabled = readOnly() || busy || Boolean(active);
    $('#episode-stop').disabled = readOnly() || busy || !active || (!own && operator());
    for (const button of document.querySelectorAll('[data-episode-phase], #episode-mark'))
      button.disabled = readOnly() || busy || !own;
  }

  async function refresh(force = false) {
    if (loading || busy || readOnly() || (!force && !pageVisible() && !active)) return;
    loading = true;
    try {
      const data = await (await get('/api/episodes/library')).json();
      status(data);
      if (!pageVisible()) return;
      const complete = data.episodes.filter(entry => entry.ended);
      const options = complete.map(entry => new Option(
        `#${entry.episode_index} · ${entry.metadata.reviewed_task || entry.metadata.task} · ${entry.samples} 帧 · ${results[entry.result]}`, entry.id));
      const version = JSON.stringify(options.map(option => [option.value, option.text]));
      if (version !== libraryVersion) {
        library.replaceChildren(new Option(options.length ? '选择已保存的 Episode' : '暂无已保存的 Episode', ''), ...options);
        libraryVersion = version;
      }
      library.value = selected || '';
    } catch (error) {
      $('#episode-status').textContent = error.message;
    } finally { loading = false; }
  }

  function pause() {
    playing = false;
    clearTimeout(timer);
    play.textContent = '播放';
  }

  function drawChart() {
    if (!detail?.frames.length || !pageVisible()) return;
    const {clientWidth: width, clientHeight: height} = chart;
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio, 2);
    chart.width = Math.round(width * ratio); chart.height = Math.round(height * ratio);
    const context = chart.getContext('2d');
    context.scale(ratio, ratio);
    const axis = Number($('#episode-axis').value), rows = detail.frames;
    const keys = ['observation.state', 'action'], colors = ['#14669d', '#c55321'];
    const values = rows.flatMap(row => keys.map(key => row[key]?.[axis])).filter(Number.isFinite);
    const low = axis === 5 ? 0 : Math.min(0, ...values) - 1;
    const high = axis === 5 ? 1 : Math.max(0, ...values) + 1;
    const x = time => 44 + (width - 54) * time / (rows.at(-1).timestamp || 1);
    const y = value => 10 + (height - 32) * (high - value) / (high - low);
    context.font = '11px system-ui';
    context.fillStyle = '#52677a';
    for (let i = 0; i <= 4; i++) {
      const value = low + (high - low) * i / 4;
      context.fillText(value.toFixed(axis === 5 ? 2 : 0), 5, y(value) + 4);
      context.strokeStyle = '#d9e1e8'; context.beginPath(); context.moveTo(44, y(value)); context.lineTo(width - 10, y(value)); context.stroke();
    }
    for (const [i, key] of keys.entries()) {
      context.strokeStyle = colors[i]; context.lineWidth = 1.7; context.beginPath();
      let previous = -2;
      for (const row of rows) {
        const value = row[key]?.[axis];
        if (!Number.isFinite(value)) { previous = -2; continue; }
        if (row.frame_index === previous + 1) context.lineTo(x(row.timestamp), y(value));
        else { context.moveTo(x(row.timestamp), y(value)); context.lineTo(x(row.timestamp) + 1, y(value)); }
        previous = row.frame_index;
      }
      context.stroke();
    }
    const cursor = x(rows[position].timestamp);
    context.strokeStyle = '#415263'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(cursor, 8); context.lineTo(cursor, height - 18); context.stroke();
    context.fillText(axis === 5 ? '开度 0–1' : '角度 (°)', 44, height - 4);
  }

  function cells(body, rows) {
    body.replaceChildren();
    for (const values of rows) {
      const tr = body.insertRow();
      for (const value of values) tr.insertCell().textContent = Number.isFinite(value) ? value.toFixed(3) : value ?? '—';
    }
  }

  async function frameAt(index) {
    if (!detail?.frames.length) return;
    mediaRequest?.abort();
    const controller = new AbortController();
    mediaRequest = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    const row = detail.frames[index];
    seek.value = index;
    let media;
    try {
      media = await Promise.all([...rgb, 'depth'].map(async channel => {
        if (!row[channel === 'depth' ? 'observation.depth' : `observation.images.${channel}`]) return null;
        try {
          const response = await get(endpoint('media', detail.id, {frame: row.frame_index, channel}), signal);
          return channel === 'depth' ? parseDepthPacket(await response.arrayBuffer()) : await createImageBitmap(await response.blob());
        } catch { return null; }
      }));
      if (controller.signal.aborted) return;
      for (const [i, channel] of [...rgb, 'depth'].entries()) {
        const {element, message} = figures[channel], value = media[i];
        element.hidden = !value;
        message.hidden = Boolean(value);
        if (!value) { message.textContent = '该帧缺少画面或读取超时'; continue; }
        if (channel === 'depth') {
          const {width, height, suggested_range_mm: scale = [50, 1000]} = value.meta;
          element.width = width; element.height = height;
          element.getContext('2d').putImageData(new ImageData(colorizeDepth(value, ...scale), width, height), 0, 0);
        } else {
          element.width = value.width; element.height = value.height;
          element.getContext('2d').drawImage(value, 0, 0);
        }
      }
      position = index;
      $('#episode-position').textContent = `${row.timestamp.toFixed(2)} s · 帧 ${row.frame_index}`;
      $('#episode-sync').textContent = Object.entries(row.sync_ms).map(([name, ms]) => `${labels[name]} ${ms} ms`).join(' · ');
      const reasons = decisions.get(row.frame_index);
      $('#episode-quality').textContent = reasons ? (reasons.length ? reasons.map(reasonText).join('、') : '当前帧已纳入训练片段') : '当前帧待清洗';
      cells($('#episode-values'), [['实测', ...(row['observation.state'] || Array(6).fill('—'))], ['指令', ...(row.action || Array(6).fill('—'))]]);
      drawChart();
    } catch (error) {
      if (!controller.signal.aborted) $('#episode-message').textContent = error.message;
    } finally {
      for (const bitmap of media?.slice(0, rgb.length) || []) bitmap?.close();
    }
  }

  function applyReview(saved) {
    decisions = new Map(saved?.decisions.map(item => [item.frame_index, item.reasons]) || []);
    $('#episode-review-status').textContent = saved ? `保留 ${saved.accepted} / ${saved.total} 帧 · ${saved.clips.length} 个连续片段` +
      (Object.keys(saved.rejected_reasons).length ? ' · ' + Object.entries(saved.rejected_reasons).map(([key, count]) => `${reasonText(key)} ${count}`).join('，') : '') : '';
    $('#episode-training').hidden = !saved?.accepted || detail.result !== 'success';
    $('#episode-normalization').hidden = !saved?.normalization;
    if (saved?.normalization) {
      cells($('#episode-normalization tbody'), Object.entries(saved.normalization).flatMap(([key, values]) =>
        [['observation.state' === key ? '实测' : '动作', '均值', ...values.mean],
         ['observation.state' === key ? '实测' : '动作', '标准差', ...values.std]]));
    }
  }

  async function choose(id) {
    pause(); mediaRequest?.abort(); selectionRequest?.abort();
    selected = id;
    $('#episode-detail').hidden = true;
    if (!id) return;
    for (const {element, message} of Object.values(figures)) {
      element.hidden = true; message.hidden = false; message.textContent = '等待画面';
    }
    $('#episode-values').replaceChildren();
    $('#episode-sync').textContent = '';
    $('#episode-quality').textContent = '';
    chart.getContext('2d').clearRect(0, 0, chart.width, chart.height);
    const controller = new AbortController();
    selectionRequest = controller;
    try {
      const response = await get(endpoint('detail', id), AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]));
      const nextDetail = await response.json();
      if (controller.signal.aborted) return;
      detail = nextDetail;
      position = 0;
      const last = detail.frames.at(-1)?.frame_index ?? 0;
      const settings = detail.review?.settings ?? {first: 0, last, max_skew_ms: 180, min_frames: 5, third: false, depth: false};
      for (const [name, value] of Object.entries(settings)) {
        const input = review.elements[name];
        if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
      }
      review.elements.task.value = detail.metadata.reviewed_task || detail.metadata.task;
      review.elements.result.value = detail.result;
      seek.max = Math.max(0, detail.frames.length - 1);
      seek.disabled = play.disabled = $('#episode-trim-start').disabled = $('#episode-trim-end').disabled = !detail.frames.length;
      $('#episode-prepare').disabled = !detail.frames.length || readOnly();
      $('#episode-raw').href = endpoint('archive', id, {format: 'raw'});
      $('#episode-training').href = endpoint('archive', id, {format: 'training'});
      for (const [channel, name] of Object.entries(detail.metadata.camera_labels || detail.metadata.camera_roles)) {
        const tag = $('[data-episode-source="' + channel + '"]');
        tag.textContent = name;
        tag.title = detail.metadata.camera_devices?.[channel] || name;
      }
      $('#episode-events').replaceChildren(...detail.annotations.map(event => {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${event.timestamp.toFixed(2)} s · ${event.label}`;
        button.onclick = () => {
          const i = detail.frames.findIndex(row => row.timestamp >= event.timestamp);
          if (detail.frames.length) { pause(); frameAt(i < 0 ? detail.frames.length - 1 : i); }
        };
        return button;
      }));
      applyReview(detail.review);
      $('#episode-detail').hidden = false;
      if (detail.frames.length) await frameAt(0);
      else $('#episode-position').textContent = '该 Episode 没有保存帧';
    } catch (error) {
      if (!controller.signal.aborted) $('#episode-message').textContent = error.message;
    }
  }

  async function act(action, data, message) {
    if (busy) return null;
    busy = true;
    try {
      const result = await api(`episode-${action}`, data);
      $('#episode-message').textContent = message;
      return result;
    } catch (error) { $('#episode-message').textContent = error.message; return null; }
    finally { busy = false; }
  }

  record.onsubmit = async event => {
    event.preventDefault();
    const result = await act('start', Object.fromEntries(new FormData(record)), '已开始记录，可进入机械臂控制进行示教');
    if (result?.active) { owned = result.active.id; sessionStorage.setItem('nexarm-episode-id', owned); status(result); }
    refresh();
  };
  $('#episode-stop').onclick = async () => {
    if (!active) return;
    const result = await act('stop', {id: active.id, result: $('#episode-result').value}, 'Episode 已保存');
    if (result?.id) {
      active = null; owned = null; sessionStorage.removeItem('nexarm-episode-id');
      const pending = choose(result.id); await refresh(); await pending;
    }
  };
  const mark = label => active && act('mark', {id: active.id, label}, '标注已保存');
  for (const button of document.querySelectorAll('[data-episode-phase]')) button.onclick = () => mark(button.dataset.episodePhase);
  $('#episode-mark').onclick = async () => { const input = $('#episode-label'); if (await mark(input.value)) input.value = ''; };
  review.onsubmit = async event => {
    event.preventDefault();
    const id = selected, data = Object.fromEntries(new FormData(review));
    for (const key of ['first', 'last', 'max_skew_ms', 'min_frames']) data[key] = Number(data[key]);
    for (const key of ['third', 'depth']) data[key] = review.elements[key].checked;
    const saved = await act('review', {id, ...data}, '已保存任务、结果和清洗设置');
    if (saved && id === selected) {
      detail.result = data.result; detail.review = saved; applyReview(saved); frameAt(position); refresh();
    }
  };
  review.oninput = () => { $('#episode-training').hidden = true; };
  library.onchange = () => choose(library.value);
  seek.oninput = () => { pause(); frameAt(Number(seek.value)); };
  $('#episode-axis').onchange = drawChart;
  new ResizeObserver(drawChart).observe(chart);
  $('#episode-trim-start').onclick = () => { review.elements.first.value = detail.frames[position].frame_index; };
  $('#episode-trim-end').onclick = () => { review.elements.last.value = detail.frames[position].frame_index; };
  play.onclick = () => {
    if (playing) { pause(); return; }
    playing = true; play.textContent = '暂停';
    let next = position >= detail.frames.length - 1 ? 0 : position + 1;
    async function advance() {
      if (!playing || !pageVisible() || next >= detail.frames.length) { pause(); return; }
      const started = performance.now();
      await frameAt(next++);
      if (!playing) return;
      const rows = detail.frames;
      const delay = next < rows.length ? (rows[next].timestamp - rows[next - 1].timestamp) * 1000 : 0;
      timer = setTimeout(advance, Math.max(0, delay - (performance.now() - started)));
    }
    advance();
  };
  setInterval(refresh, 1500);
  return {refresh, pause};
}

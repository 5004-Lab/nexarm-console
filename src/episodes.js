import { colorizeDepth, parseDepthPacket } from './depth-data.js';
import { episodeChart, trajectoryNames, trajectoryValues } from './episode-chart.js';

const rgb = ['front', 'wrist', 'third'];
const cameraOrder = ['front', 'depth', 'wrist', 'third'];
const labels = {front: 'D405 RGB', depth: 'D405 深度', wrist: '腕部 RGB 相机', third: '第三人称相机', feedback: '关节反馈', action: '下发指令'};
const channelNames = {front: 'Front', depth: 'Depth · 原始 16 位', wrist: 'Wrist', third: 'Third'};
const results = { recording: '采集中', success: '成功', failure: '失败', unrated: '待评定', interrupted: '中断' };
const phases = ['接近', '夹取', '提起', '搬运', '放置', '撤离'];
const phaseColors = ['#0072BD', '#B94B14', '#8A5A04', '#7E2F8E', '#488224', '#236F88'];
const axes = ['J1', 'J2', 'J3', 'J4', 'J5', '夹爪'];
const sourceKeys = ['feedback', 'front', 'wrist', 'third', 'depth', 'action'];
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
    </div>
    <div class="episode-streams" aria-label="固定采集通道">${cameraOrder.map(channel =>
      `<div><strong>${labels[channel]}</strong><span>${channelNames[channel]}</span><output data-episode-count="${channel}" hidden></output></div>`).join('')}</div>
    <div class="episode-actions"><button class="primary-button" id="episode-start">开始 Episode</button>
      <button type="button" id="episode-stop" disabled>结束并保存</button>
      <label>执行结果<select id="episode-result"><option value="unrated">待评定</option><option value="success">成功</option><option value="failure">失败</option></select></label>
      <a href="#control">进入机械臂控制</a><span>5 Hz · 三路 RGB + 原始深度 · 最长 20 分钟</span>
    </div>
  </form>
  <output class="episode-message" id="episode-message" role="status"></output>
  <header class="section-heading"><h2>Episode 回放与清洗</h2><select id="episode-library" aria-label="选择 Episode"><option value="">正在加载…</option></select></header>
  <div id="episode-detail" hidden>
    <div class="episode-preview" aria-label="同步回放画面">${cameraOrder.map(channel => `<figure data-episode-channel="${channel}">
      <figcaption><strong data-episode-source="${channel}">${labels[channel]}</strong><span>${channelNames[channel]}</span><time data-episode-source-time="${channel}"></time></figcaption>
      <div><canvas hidden role="img" aria-label="${labels[channel]} 回放"></canvas>
      <span data-episode-missing="${channel}">等待画面</span></div>
    </figure>`).join('')}</div>
    <div class="episode-actions episode-player">
      <button type="button" id="episode-previous" aria-label="上一帧">‹</button><button type="button" id="episode-play">播放</button>
      <button type="button" id="episode-next" aria-label="下一帧">›</button><output id="episode-position"></output>
      <input id="episode-seek" type="range" min="0" value="0" aria-label="Episode 时间轴">
    </div>
    <section class="episode-segments" aria-label="片段标注">
      <header class="section-heading"><h2>片段标注</h2><span>在时间带拖选，或逐帧设置起点和终点</span></header>
      <div class="episode-track-group">
        <div class="episode-track-times"><span id="episode-track-first">0.000 s</span><span id="episode-track-last"></span></div>
        <div id="episode-track" aria-label="阶段时间带"><div id="episode-bands"></div>
          <div id="episode-selection" hidden></div><i id="episode-playhead" hidden></i></div>
      </div>
      <form id="episode-segment" class="episode-actions">
        <button type="button" id="episode-segment-start">设起点</button><output id="episode-bound-start">—</output>
        <button type="button" id="episode-segment-end">设终点</button><output id="episode-bound-end">—</output>
        <label>阶段 <select name="phase"><option value="">请选择</option>${phases.map(label => `<option>${label}</option>`).join('')}<option value="custom">自定义</option></select></label>
        <input name="label" maxlength="120" placeholder="阶段或剔除原因" aria-label="自定义阶段或剔除原因">
        <button class="primary-button" id="episode-save-segment">保存阶段</button>
        <button type="button" id="episode-exclude">标记剔除</button>
        <button type="button" id="episode-play-segment">播放选中片段</button>
        <button type="button" id="episode-segment-reset">清除选择</button>
        <output id="episode-segment-message" role="status"></output>
      </form>
      <div id="episode-segment-list"></div>
    </section>
    <div class="episode-analysis">
      <section aria-label="实测与动作曲线">
        <header class="section-heading"><h2>六轴与夹爪轨迹</h2>
          <div class="episode-actions"><span>实线 · 实测　虚线 · 指令</span><label><input id="episode-show-command" type="checkbox" checked>显示指令</label>
          <button type="button" id="episode-chart-export">SVG ↓</button></div></header>
        <div id="episode-chart" role="img" aria-label="六轴角度与夹爪开度曲线"></div>
        <table aria-label="当前帧实测与动作"><thead><tr><th>信号</th>${trajectoryNames.map((name, index) => `<th>${name} (${index === 6 ? '%' : '°'})</th>`).join('')}</tr></thead>
          <tbody id="episode-values"></tbody></table>
      </section>
      <section aria-label="时间戳与质量"><header class="section-heading"><h2>当前帧时间戳</h2><span>Episode 相对时间</span></header>
        <table aria-label="当前帧时间戳"><thead><tr><th>数据源</th><th>时间 (s)</th><th>偏移 (ms)</th></tr></thead><tbody id="episode-timestamps"></tbody></table>
        <output id="episode-sync"></output><output id="episode-quality"></output><button type="button" id="episode-next-rejected" hidden>跳到下一剔除帧</button>
        <div id="episode-events"></div></section>
    </div>
    <form id="episode-review" class="episode-form">
      <div class="episode-fields"><label>训练任务<input name="task" required maxlength="240"></label>
        <label>结果<select name="result">${resultOptions}</select></label>
        <label>起始帧<input name="first" type="number" min="0" required></label>
        <label>结束帧<input name="last" type="number" min="0" required></label>
        <label>模态间最大时差 (ms)<input name="max_skew_ms" type="number" min="5" max="350" value="45" required></label>
        <label>源帧最大时效 (ms)<input name="max_age_ms" type="number" min="10" max="350" value="120" required></label>
        <label>深度有效覆盖下限 (%)<input name="min_depth_percent" type="number" min="1" max="100" value="1" required></label>
        <label>最短连续帧数<input name="min_frames" type="number" min="2" max="300" value="5" required></label></div>
      <div class="episode-actions"><label><input name="third" type="checkbox">清洗要求 Third</label>
        <label><input name="depth" type="checkbox">清洗要求 Depth</label>
        <button type="button" id="episode-use-selected">选中片段作裁剪范围</button>
        <button class="primary-button" id="episode-prepare">清洗和计算归一化</button>
        <a id="episode-raw">下载原始包</a><a id="episode-training" hidden>下载训练包</a>
      </div>
      <output id="episode-review-status" role="status"></output>
      <details id="episode-normalization" hidden><summary>逐维归一化统计</summary><table><thead>
        <tr><th>信号</th><th>统计</th>${axes.map(axis => `<th>${axis}</th>`).join('')}</tr></thead><tbody></tbody></table></details>
    </form>
  </div>
</section>`;

const reasonNames = {trim: '裁剪范围外', manual_exclude: '手动剔除', no_action: '缺少下发指令', invalid_action: '无效指令', invalid_feedback: '无效反馈', sensor_span: '模态间时差过大', short_clip: '连续片段过短', empty_depth: '深度有效覆盖不足', feedback_spike: '孤立关节尖峰'};
function reasonText(key) {
  if (reasonNames[key]) return reasonNames[key];
  const [kind, signal] = key.split('_');
  return `${labels[signal] || signal}${{missing: '缺失', skew: '超出时效', repeat: '重复或倒序'}[kind] || key}`;
}

export function createEpisodes(api, readOnly, operator) {
  const $ = selector => document.querySelector(selector);
  const record = $('#episode-record'), review = $('#episode-review'), library = $('#episode-library');
  const play = $('#episode-play'), seek = $('#episode-seek'), track = $('#episode-track');
  const segmentForm = $('#episode-segment');
  const figures = Object.fromEntries([...document.querySelectorAll('[data-episode-channel]')].map(figure =>
    [figure.dataset.episodeChannel, {element: figure.querySelector('canvas'), message: figure.querySelector('[data-episode-missing]')}]));
  let active, detail, selected, decisions = new Map(), position = 0;
  let first = null, last = null, editing = null, drag = null, framePending = false;
  let owned = sessionStorage.getItem('nexarm-episode-id');
  let loading = false, busy = false, playing = false, playGeneration = 0, timer, mediaRequest, selectionRequest;
  let libraryVersion;
  const trajectory = episodeChart($('#episode-chart'), time => jump(indexAt(time)));

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
    for (const channel of cameraOrder) {
      const counter = $(`[data-episode-count="${channel}"]`);
      counter.hidden = !active?.media_counts;
      if (active?.media_counts) counter.textContent = `${active.media_counts[channel]} / ${active.samples} 帧`;
    }
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
    playGeneration++;
    clearTimeout(timer);
    play.textContent = '播放';
  }

  function indexAt(time) {
    const rows = detail?.frames;
    if (!rows?.length) return 0;
    let low = 0, high = rows.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (rows[mid].timestamp < time) low = mid + 1;
      else high = mid;
    }
    return low > 0 && time - rows[low - 1].timestamp < rows[low].timestamp - time ? low - 1 : low;
  }

  const at = time => Number.isFinite(time) ? `${time.toFixed(3)} s` : '—';
  const framePosition = frame => indexAt(frame / (detail?.fps || 5));
  const timeAt = frame => frame / detail.fps;
  const trackEnd = () => (detail?.frames.at(-1)?.timestamp ?? 0) + 1 / (detail?.fps || 5);
  const trackPercent = time => Math.max(0, Math.min(100, 100 * time / trackEnd()));

  function jump(index) {
    if (!detail?.frames.length) return;
    pause();
    return frameAt(Math.max(0, Math.min(index, detail.frames.length - 1)));
  }

  async function playRange(start, end) {
    if (!detail?.frames.length) return;
    pause();
    playing = true;
    const token = ++playGeneration;
    play.textContent = '暂停';
    async function advance(index) {
      if (token !== playGeneration) return;
      if (!pageVisible() || index > end) { pause(); return; }
      const started = performance.now();
      await frameAt(index);
      if (token !== playGeneration) return;
      if (index === end) { pause(); return; }
      const period = (detail.frames[index + 1].timestamp - detail.frames[index].timestamp) * 1000;
      timer = setTimeout(() => advance(index + 1), Math.max(0, period - (performance.now() - started)));
    }
    await advance(start);
  }

  function styleBand(element, firstFrame, lastFrame) {
    const left = trackPercent(timeAt(firstFrame));
    const right = trackPercent(timeAt(lastFrame + 1));
    element.style.left = `${left}%`;
    element.style.width = `${right - left}%`;
  }

  function paintSelection() {
    const rows = detail?.frames || [];
    const hasFrames = rows.length > 0;
    const range = first !== null && last !== null && first <= last;
    const sliderSelection = $('#episode-selection');
    sliderSelection.hidden = first === null && last === null;
    if (!sliderSelection.hidden && hasFrames)
      styleBand(sliderSelection, Math.min(first ?? last, last ?? first), Math.max(first ?? last, last ?? first));
    $('#episode-bound-start').textContent = first === null ? '—' : `#${first} · ${at(timeAt(first))}`;
    $('#episode-bound-end').textContent = last === null ? '—' : `#${last} · ${at(timeAt(last))}`;
    $('#episode-segment-start').disabled = $('#episode-segment-end').disabled = !hasFrames || framePending;
    $('#episode-save-segment').disabled = $('#episode-exclude').disabled = !range || readOnly();
    $('#episode-play-segment').disabled = $('#episode-use-selected').disabled = !range;
    $('#episode-segment-reset').disabled = first === null && last === null;
    $('#episode-save-segment').textContent = editing?.kind === 'stage' ? '更新阶段' : '保存阶段';
    $('#episode-exclude').textContent = editing?.kind === 'exclude' ? '更新剔除范围' : '标记剔除';
  }

  function setBounds(a = null, b = null, segment = null) {
    first = a; last = b; editing = segment;
    segmentForm.elements.phase.value = segment?.kind === 'stage' ?
      (phases.includes(segment.label) ? segment.label : 'custom') : '';
    segmentForm.elements.label.value = segment && (segment.kind === 'exclude' || !phases.includes(segment.label)) ? segment.label : '';
    $('#episode-segment-message').textContent = '';
    paintSelection();
  }

  function paintSegments() {
    const bands = $('#episode-bands'), list = $('#episode-segment-list');
    bands.replaceChildren(); list.replaceChildren();
    $('#episode-track-last').textContent = at(detail.frames.at(-1)?.timestamp);
    for (const segment of detail.segments || []) {
      const {kind, label, first, last, start_timestamp, end_timestamp} = segment;
      const times = `${at(start_timestamp)} – ${at(end_timestamp)}`;
      const caption = kind === 'exclude' ? `剔除 · ${label}` : label;
      const band = Object.assign(document.createElement('button'), {type: 'button', className: `episode-band ${kind}`,
        textContent: caption, title: `${caption} · ${times}`});
      band.style.setProperty('--stage-color', phaseColors[phases.indexOf(label)] || '#375d85');
      styleBand(band, first, last);
      band.onclick = () => { setBounds(first, last, segment); jump(framePosition(first)); };
      bands.append(band);

      const row = document.createElement('div');
      const edit = Object.assign(document.createElement('button'), {type: 'button', textContent: `${caption} · #${first}–#${last} · ${times}`});
      edit.onclick = band.onclick;
      const run = Object.assign(document.createElement('button'), {type: 'button', textContent: '播放', ariaLabel: `播放 ${caption}`});
      run.onclick = () => playRange(framePosition(first), framePosition(last));
      const remove = Object.assign(document.createElement('button'), {type: 'button', textContent: '删除', ariaLabel: `删除 ${caption}`, disabled: readOnly()});
      remove.onclick = () => saveSegment({segment: segment.id, remove: true});
      row.append(edit, run, remove);
      list.append(row);
    }
  }

  async function saveSegment(values) {
    const id = selected;
    const result = await act('segment', {id, ...values}, '', $('#episode-segment-message'));
    if (!result || id !== selected) return;
    detail.segments = result.segments;
    if (detail.review && !result.review) {
      detail.review = null;
      applyReview(null);
      $('#episode-review-status').textContent = '剔除范围已更改，请重新清洗后导出';
    }
    setBounds();
    $('#episode-segment-message').textContent = values.remove ? '已删除片段' : '已保存片段';
    paintSegments();
    paintCurrent(detail.frames[position]);
  }

  function cells(body, rows) {
    body.replaceChildren();
    for (const values of rows) {
      const tr = body.insertRow();
      for (const value of values) tr.insertCell().textContent = Number.isFinite(value) ? value.toFixed(3) : value ?? '—';
    }
  }

  function paintCurrent(row) {
    if (!row) return;
    const {timestamp, frame_index: frame} = row;
    const quality = decisions.get(frame);
    const stage = detail.segments.find(s => s.kind === 'stage' && s.first <= frame && s.last >= frame);
    const excluded = detail.segments.find(s => s.kind === 'exclude' && s.first <= frame && s.last >= frame);
    $('#episode-position').textContent = `${at(timestamp)} · 帧 ${frame}${stage ? ' · ' + stage.label : ''}`;
    for (const channel of [...rgb, 'depth']) {
      const time = row.source_timestamps[channel];
      $(`[data-episode-source-time="${channel}"]`).textContent = at(time);
    }
    cells($('#episode-timestamps'), [['采样目标', at(timestamp), '0.00'], ...sourceKeys.map(key => {
      const time = row.source_timestamps[key];
      const offset = key === 'action' && Number.isFinite(time) ? (time - timestamp) * 1000 : row.sync_ms[key];
      return [sourceTitle(key), at(time), Number.isFinite(offset) ? offset.toFixed(2) : '—'];
    })]);
    const offsets = Object.values(row.sync_ms);
    const span = offsets.length >= 2 ? (Math.max(...offsets) - Math.min(...offsets)).toFixed(2) : '—';
    $('#episode-sync').textContent = `已到齐观测的时间跨度 ${span} ms`;
    $('#episode-quality').textContent = quality ? (quality.reasons.length ? quality.reasons.map(reasonText).join('、') :
      '当前帧已纳入训练片段') : excluded ? `已标记剔除 · ${excluded.label}` : '当前帧待清洗';
    cells($('#episode-values'), [['实测', ...trajectoryValues(row)], ['指令', ...trajectoryValues(row, true)]]);
    const playhead = $('#episode-playhead');
    playhead.hidden = false; playhead.style.left = `${trackPercent(timestamp)}%`;
    trajectory.position(timestamp);
  }

  function sourceTitle(channel) {
    const role = detail.metadata.camera_roles?.[channel];
    if (role === 'd405' && channel !== 'depth') return 'D405 RGB';
    if (role === 'external') return '第三人称相机';
    if (role === 'hdr') return 'HDR 全景';
    return labels[channel];
  }

  async function frameAt(index) {
    if (!detail?.frames.length) return;
    mediaRequest?.abort();
    const controller = new AbortController();
    mediaRequest = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    const row = detail.frames[index];
    framePending = true;
    seek.setAttribute('aria-busy', 'true');
    paintSelection();
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
      position = index; seek.value = row.frame_index;
      paintCurrent(row);
    } catch (error) {
      if (!controller.signal.aborted) $('#episode-message').textContent = error.message;
    } finally {
      for (const bitmap of media?.slice(0, rgb.length) || []) bitmap?.close();
      if (mediaRequest === controller) {
        framePending = false;
        seek.setAttribute('aria-busy', 'false');
        paintSelection();
      }
    }
  }

  function applyReview(saved) {
    decisions = new Map(saved?.decisions.map(item => [item.frame_index, item]) || []);
    const sync = saved?.sync;
    $('#episode-review-status').textContent = saved ? `保留 ${saved.accepted} / ${saved.total} 帧 · ${saved.clips.length} 个连续片段` +
      (sync ? ` · 时差 P50 ${sync.p50_ms} / P95 ${sync.p95_ms} / 最大 ${sync.max_ms} ms` : '') +
      (saved.skipped_ticks ? ` · 缺采样点 ${saved.skipped_ticks}` : '') +
      (Object.keys(saved.rejected_reasons).length ? ' · ' + Object.entries(saved.rejected_reasons).map(([key, count]) => `${reasonText(key)} ${count}`).join('，') : '') : '';
    $('#episode-next-rejected').hidden = !saved?.decisions.some(row => row.reasons.length);
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
    mediaRequest = null; framePending = false;
    selected = id;
    $('#episode-detail').hidden = true;
    if (!id) return;
    for (const {element, message} of Object.values(figures)) {
      element.hidden = true; message.hidden = false; message.textContent = '等待画面';
    }
    $('#episode-values').replaceChildren();
    $('#episode-timestamps').replaceChildren();
    $('#episode-playhead').hidden = true;
    $('#episode-sync').textContent = '';
    $('#episode-quality').textContent = '';
    trajectory.load([]);
    const controller = new AbortController();
    selectionRequest = controller;
    try {
      const response = await get(endpoint('detail', id), AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]));
      const nextDetail = await response.json();
      if (controller.signal.aborted) return;
      detail = nextDetail;
      detail.segments ??= [];
      position = 0;
      const last = detail.frames.at(-1)?.frame_index ?? 0;
      const settings = {first: 0, last, max_skew_ms: 45, max_age_ms: 120,
        min_depth_percent: 1, min_frames: 5, third: true, depth: true, ...detail.review?.settings};
      for (const [name, value] of Object.entries(settings)) {
        const input = review.elements[name];
        if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
      }
      review.elements.task.value = detail.metadata.reviewed_task || detail.metadata.task;
      review.elements.result.value = detail.result;
      seek.max = last;
      seek.disabled = play.disabled = $('#episode-previous').disabled = $('#episode-next').disabled = !detail.frames.length;
      $('#episode-chart-export').disabled = !detail.frames.length;
      $('#episode-prepare').disabled = !detail.frames.length || readOnly();
      $('#episode-raw').href = endpoint('archive', id, {format: 'raw'});
      $('#episode-training').href = endpoint('archive', id, {format: 'training'});
      for (const channel of cameraOrder) {
        const tag = $('[data-episode-source="' + channel + '"]');
        const name = sourceTitle(channel);
        tag.textContent = name;
        tag.title = detail.metadata.camera_devices?.[channel] || name;
        figures[channel].element.setAttribute('aria-label', name + ' 回放');
      }
      $('#episode-events').replaceChildren(...detail.annotations.map(event => {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${event.timestamp.toFixed(2)} s · ${event.label}`;
        button.onclick = () => jump(indexAt(event.timestamp));
        return button;
      }));
      applyReview(detail.review);
      setBounds();
      paintSegments();
      $('#episode-detail').hidden = false;
      trajectory.load(detail.frames);
      if (detail.frames.length) await frameAt(0);
      else $('#episode-position').textContent = '该 Episode 没有保存帧';
    } catch (error) {
      if (!controller.signal.aborted) $('#episode-message').textContent = error.message;
    }
  }

  async function act(action, data, message, output = $('#episode-message')) {
    if (busy) return null;
    busy = true;
    try {
      const result = await api(`episode-${action}`, data);
      output.textContent = message;
      return result;
    } catch (error) { output.textContent = error.message; return null; }
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
  review.onsubmit = async event => {
    event.preventDefault();
    const id = selected, data = Object.fromEntries(new FormData(review));
    for (const key of ['first', 'last', 'max_skew_ms', 'max_age_ms', 'min_depth_percent', 'min_frames']) data[key] = Number(data[key]);
    for (const key of ['third', 'depth']) data[key] = review.elements[key].checked;
    const saved = await act('review', {id, ...data}, '已保存任务、结果和清洗设置');
    if (saved && id === selected) {
      detail.result = data.result; detail.review = saved; applyReview(saved); paintCurrent(detail.frames[position]); refresh();
    }
  };
  review.oninput = () => { $('#episode-training').hidden = true; };
  library.onchange = () => choose(library.value);
  seek.oninput = () => jump(framePosition(Number(seek.value)));
  $('#episode-previous').onclick = () => jump(position - 1);
  $('#episode-next').onclick = () => jump(position + 1);
  play.onclick = () => {
    if (playing) { pause(); return; }
    const end = detail.frames.length - 1;
    playRange(position === end ? 0 : position + 1, end);
  };
  $('#episode-show-command').onchange = event => trajectory.commands(event.target.checked);
  $('#episode-chart-export').onclick = () => trajectory.download(detail.episode_index);
  $('#episode-next-rejected').onclick = () => {
    const rejected = [...decisions.values()].filter(row => row.reasons.length);
    const current = detail.frames[position].frame_index;
    const next = rejected.find(row => row.frame_index > current) || rejected[0];
    if (next) jump(framePosition(next.frame_index));
  };

  function selectBoundary(start) {
    pause();
    const current = detail.frames[position].frame_index;
    if (start) first = current;
    else last = current;
    paintSelection();
  }
  $('#episode-segment-start').onclick = () => selectBoundary(true);
  $('#episode-segment-end').onclick = () => selectBoundary(false);
  $('#episode-segment-reset').onclick = () => setBounds();
  $('#episode-play-segment').onclick = () => playRange(framePosition(first), framePosition(last));
  $('#episode-use-selected').onclick = () => {
    review.elements.first.value = first;
    review.elements.last.value = last;
    review.oninput();
  };
  segmentForm.onsubmit = event => {
    event.preventDefault();
    const phase = segmentForm.elements.phase.value;
    const label = phase === 'custom' ? segmentForm.elements.label.value.trim() : phase;
    if (!label) { $('#episode-segment-message').textContent = '请选择阶段或填写自定义名称'; return; }
    saveSegment({kind: 'stage', first, last, label, segment: editing?.kind === 'stage' ? editing.id : null});
  };
  $('#episode-exclude').onclick = () => saveSegment({kind: 'exclude', first, last,
    label: segmentForm.elements.label.value.trim() || '手动剔除', segment: editing?.kind === 'exclude' ? editing.id : null});
  const frameAtPointer = event => {
    const bounds = track.getBoundingClientRect();
    const time = (event.clientX - bounds.left) / bounds.width * trackEnd();
    return detail.frames[indexAt(time)].frame_index;
  };
  track.onpointerdown = event => {
    if (event.button !== 0 || !detail?.frames.length || event.target.closest('button')) return;
    pause(); drag = frameAtPointer(event);
    track.setPointerCapture(event.pointerId);
    setBounds(drag, drag);
  };
  function dragTo(event) {
    const frame = frameAtPointer(event);
    first = Math.min(drag, frame); last = Math.max(drag, frame);
    paintSelection();
  }
  track.onpointermove = event => { if (drag !== null) dragTo(event); };
  track.onpointerup = event => {
    if (drag === null) return;
    dragTo(event); drag = null;
    jump(framePosition(first));
  };
  track.onpointercancel = () => { drag = null; };
  setInterval(refresh, 1500);
  return {refresh, pause};
}

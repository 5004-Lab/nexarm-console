import { init, use } from 'echarts/core';
import { CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import { DataZoomComponent, GraphicComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapContinuousComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import joints from './joints.json';
import reach from './reach.json';
import { jointAngle } from './joint-units.js';
import { plotSamples, channelPoints, timeTooltip, readingLabel } from './telemetry-series.js';

use([CustomChart, LineChart, ScatterChart, DataZoomComponent, GraphicComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapContinuousComponent, SVGRenderer]);

// MATLAB light-theme ColorOrder (gem).
const gem = ['#0072BD', '#D95319', '#EDB120', '#7E2F8E', '#77AC30', '#4DBEEE'];
const fontFamily = 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
const axisNames = joints.map((_, i) => `J${i + 1}`);
const limits = joints.map((joint, i) => [jointAngle(i, joint.min), jointAngle(i, joint.max)].sort((a, b) => a - b));
const closedAngle = limits[5][1];
let displaySeconds = 0;
let operationEvents = [];
const figures = {
  angle: { title: '六轴关节角度', axis: '关节角度 (°)', names: axisNames, pad: 10 },
  speed: { title: '六轴角速度', axis: '角速度 (°/s)', names: axisNames, pad: 3, symmetric: true },
  acceleration: { title: '六轴角加速度', axis: '角加速度 (°/s²)', names: axisNames, pad: 10, symmetric: true },
  gripper: { title: '夹爪开合度', axis: '开度 (%)', names: ['夹爪'], range: [0, 100] },
  tcp: { title: '末端位置', axis: '位置 (mm)', names: ['X', 'Y', 'Z'], pad: 10 },
  error: { title: '指令跟踪误差', axis: '跟踪误差 (°)', names: axisNames, pad: 1, symmetric: true },
  sync: { title: '视频与编码器时差', axis: '时差 (ms)', names: ['RGB ↔ 编码器'], range: [0, 150] },
  range: { title: '六轴运动范围', axis: '模型角度 (°)' },
  workspace: { title: '工作空间 · XY 投影', axis: '模型可达采样' },
};

export function chart(signal) {
  const { title, axis } = figures[signal];
  return `<figure class="panel scientific-chart" data-figure="${signal}">
    <figcaption class="panel-header"><h2>${title}</h2><button type="button" class="figure-export" aria-label="导出${title} SVG" title="下载矢量图">SVG ↓</button></figcaption>
    <div class="figure-surface" role="img" aria-label="${title}，${axis}"></div>
  </figure>`;
}

export function jointRangeTable() {
  return `<section class="panel range-panel" aria-labelledby="range-panel-title">
    <header class="panel-header"><h2 id="range-panel-title">六轴运动范围</h2><span class="chart-unit">模型角度 (°)</span></header>
    <div class="range-body">
    <table aria-label="各舵机常规角度范围与实测">
      <thead><tr><th scope="col">关节</th><th scope="col">下限</th><th scope="col">实测</th><th scope="col">上限</th></tr></thead>
      <tbody>${joints.map((joint, i) => `<tr data-limit="${i}" style="--trace:${gem[i]}">
        <th scope="row" title="${joint.name}"><i></i>J${i + 1} <span>${joint.name}</span></th>
        <td>${limits[i][0].toFixed(1)}</td><td><output>—</output></td><td>${limits[i][1].toFixed(1)}</td>
      </tr>`).join('')}</tbody>
    </table>
    </div>
    <footer class="figure-note">常规行程 · 红色实测值表示超出范围</footer>
  </section>`;
}

const textStyle = { fontFamily, color: '#20242c', fontSize: 12 };
const edge = { color: '#303640', width: 1 };
const gridLines = { color: '#e1e4e8', width: 1 };
const grid = { show: true, borderColor: '#303640', borderWidth: 1, backgroundColor: '#fff', left: 67, right: 23, top: 45, bottom: 47 };
const axis = {
  axisLine: { show: true, onZero: false, lineStyle: edge },
  axisTick: { show: true, inside: true, length: 4, lineStyle: edge },
  axisLabel: { ...textStyle, margin: 7, hideOverlap: true },
  nameTextStyle: { ...textStyle, fontSize: 13 },
  splitLine: { show: true, lineStyle: gridLines },
};
const base = { animation: false, backgroundColor: '#fff', textStyle, color: gem };
const tip = { renderMode: 'richText', confine: true, borderColor: '#acb4bd', borderWidth: 1, backgroundColor: '#fff', textStyle };
export const matlabStyle = { base, grid, axis, textStyle, tip, colors: [...gem, '#A2142F'] };

function rounded(value) {
  const number = Math.round(value * 10) / 10;
  return Number.isFinite(number) ? String(number) : '—';
}

function lineDomain(figure, samples) {
  if (figure.range) return [figure.range[0], figure.range[1], (figure.range[1] - figure.range[0]) / 5];
  const values = samples.flatMap(sample => (sample.values || []).filter(Number.isFinite));
  const lo = values.reduce((low, value) => Math.min(low, value), -figure.pad);
  const hi = values.reduce((high, value) => Math.max(high, value), figure.pad);
  const magnitude = Math.max(Math.abs(lo), hi);
  const low = figure.symmetric ? -magnitude : lo;
  const high = figure.symmetric ? magnitude : hi;
  const span = (high - low) / 5;
  const scale = 10 ** Math.floor(Math.log10(span));
  const step = scale * [1, 2, 2.5, 5, 10].find(value => value * scale >= span);
  return [Math.floor(low / step) * step, Math.ceil(high / step) * step, step];
}

function timeOption(figure, samples, compact = false) {
  const source = samples;
  samples = plotSamples(source, figure.names.length);
  const tail = samples.at(-1)?.stamp ?? 0;
  const origin = samples[0]?.stamp ?? tail;
  const elapsed = Math.max(1, tail - origin);
  const [min, max, interval] = lineDomain(figure, samples);
  const hasData = samples.some(sample => sample.values?.some(Number.isFinite));
  return {
    ...base, grid: { ...grid, left: compact ? 56 : grid.left, right: compact ? 14 : grid.right, top: compact ? 30 : grid.top, bottom: compact ? 53 : 76 },
    dataZoom: [{ id: 'time-zoom', type: 'slider', bottom: 3, height: compact ? 12 : 19, filterMode: 'none' }, { id: 'time-inside', type: 'inside', filterMode: 'none' }],
    legend: { show: true, top: compact ? 3 : 9, right: compact ? 12 : 20, icon: 'roundRect', itemWidth: 14, itemHeight: 3,
      padding: compact ? [3, 5] : [6, 8], borderColor: '#ccd1d6', borderWidth: 1, backgroundColor: '#fff', textStyle },
    xAxis: { ...axis, type: 'value', min: displaySeconds ? Math.max(0, elapsed - displaySeconds) : 0, max: elapsed, splitNumber: 6,
      axisLabel: { ...axis.axisLabel, formatter: rounded },
      name: '记录开始后的时间 (s)', nameLocation: 'middle', nameGap: compact ? 24 : 29 },
    yAxis: { ...axis, type: 'value', min, max, interval, axisLabel: { ...axis.axisLabel, formatter: rounded },
      name: figure.axis, nameLocation: 'middle', nameGap: compact ? 36 : 43 },
    graphic: { id: 'empty', type: 'text', silent: true, left: 'center', top: 'middle',
      invisible: hasData, style: { text: '等待实测数据', fill: '#5c6771', fontSize: 13, fontFamily } },
    tooltip: { ...tip, trigger: 'axis', axisPointer: { type: 'line', snap: true, lineStyle: { color: '#59646e', type: 'dashed' } },
      valueFormatter: readingLabel,
      formatter: params => {
        const point = Array.isArray(params) ? params[0] : params;
        return timeTooltip(source, Number(point?.axisValue ?? point?.value?.[0]), origin, figure.names);
      } },
    series: figure.names.map((name, i) => ({
      id: name, type: 'line', name, showSymbol: false, connectNulls: false, lineStyle: { width: 1.65 },
      markLine: i === 0 ? { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: '#8795a6', type: 'dotted' }, data: operationEvents.slice(-40).map(event => ({ xAxis: event.stamp - origin, name: event.label })) } : undefined,
      data: channelPoints(samples, i, origin),
    })),
  };
}

function rangeOption(measured) {
  return {
    ...base,
    grid: { ...grid, left: 46, right: 25, top: 23, bottom: 46 },
    xAxis: { ...axis, type: 'value', min: -200, max: 200, interval: 50, name: '模型角度 (°)', nameLocation: 'middle', nameGap: 29 },
    yAxis: { ...axis, type: 'category', inverse: true, data: axisNames, boundaryGap: true,
      axisTick: { show: false }, splitLine: { ...axis.splitLine, show: true } },
    tooltip: { ...tip, formatter: ({ data }) => {
      const [axisIndex, min, max, value] = data;
      return `${axisNames[axisIndex]} ${joints[axisIndex].name}\n常规范围  ${min.toFixed(1)}° ～ ${max.toFixed(1)}°\n实测  ${value == null ? '—' : rounded(value) + '°'}`;
    } },
    series: [{
      type: 'custom', dimensions: ['axis', 'min', 'max', 'angle'], encode: { x: ['min', 'max', 'angle'], y: 'axis' },
      data: limits.map(([lo, hi], i) => [i, lo, hi, measured?.[i] ?? null]),
      renderItem: (_params, api) => {
        const row = api.value(0);
        const [left, y] = api.coord([api.value(1), row]);
        const [right] = api.coord([api.value(2), row]);
        const point = api.value(3);
        const color = gem[row];
        const line = (x1, y1, x2, y2, width) => (
          { type: 'line', shape: { x1, y1, x2, y2 }, style: { stroke: color, lineWidth: width } }
        );
        const children = [line(left, y, right, y, 4), line(left, y - 5, left, y + 5, 1.5),
          line(right, y - 5, right, y + 5, 1.5)];
        if (Number.isFinite(point)) {
          const [x] = api.coord([point, row]);
          const outside = point < api.value(1) || point > api.value(2);
          const px = Math.max(api.coord([-200, row])[0], Math.min(api.coord([200, row])[0], x));
          children.push({ type: 'circle', shape: { cx: px, cy: y, r: 4.8 },
            style: { fill: outside ? '#a7252c' : '#20242c', stroke: '#fff', lineWidth: 1.5 } });
        }
        return { type: 'group', children };
      },
    }],
  };
}

const cell = 32;
const reachGrid = new Map();
for (const [x, y] of reach) {
  const center = [Math.round(x / cell) * cell, Math.round(y / cell) * cell];
  const key = center.join(',');
  if (!reachGrid.has(key)) reachGrid.set(key, [...center, 0]);
  reachGrid.get(key)[2]++;
}
const cells = [...reachGrid.values()];
const maxCount = Math.max(...cells.map(value => value[2]));

function reachOption(host, measured) {
  const side = Math.max(90, Math.min(host.clientWidth - 125, host.clientHeight - 58));
  const left = Math.max(49, Math.round((host.clientWidth - side - 62) / 2));
  const positionAxis = { ...axis, type: 'value', min: -550, max: 550, splitNumber: 5, nameLocation: 'middle', nameGap: 30 };
  return {
    ...base,
    grid: { ...grid, left, width: side, height: side, top: 15, right: null },
    xAxis: { ...positionAxis, name: 'X (mm)' },
    yAxis: { ...positionAxis, name: 'Y (mm)', nameGap: 39 },
    visualMap: { type: 'continuous', min: 1, max: maxCount, seriesIndex: 0, dimension: 2, calculable: false,
      top: 18, left: left + side + 14, itemHeight: Math.max(52, side - 31), itemWidth: 10,
      text: ['样本/格', '1'], textGap: 7, textStyle: { ...textStyle, fontSize: 11 },
      inRange: { color: ['#352A87', '#056FB2', '#0F9FB5', '#58B982', '#BFCA41', '#F9E721'] } },
    tooltip: { ...tip, formatter: ({ value, seriesIndex }) => seriesIndex === 0
      ? `X ${value[0]} mm · Y ${value[1]} mm\n${value[2]} 个可达样本` : `实测末端\nX ${value[0]} mm · Y ${value[1]} mm` },
    series: [{ id: 'density', type: 'custom', data: cells, encode: { x: 0, y: 1 },
      renderItem: (_p, api) => {
        const center = api.coord([api.value(0), api.value(1)]);
        const [width, height] = api.size([cell, cell]);
        return { type: 'rect', shape: { x: center[0] - width / 2, y: center[1] - height / 2, width, height },
          style: { fill: api.visual('color') } };
      },
    }, { id: 'tcp', type: 'scatter', symbolSize: 9, data: measured ? [[measured[0], measured[1]]] : [],
      itemStyle: { color: '#17212d', borderColor: '#fff', borderWidth: 1.5, opacity: 1 } }],
  };
}

function mountFigure(panel, getOption, getRevision) {
  const host = panel.querySelector('.figure-surface');
  let figure;
  let rendered;
  function update(resize = false) {
    if (!host.clientWidth || !host.clientHeight) return;
    const revision = getRevision();
    if (!resize && figure && rendered === revision) return;
    if (!figure) figure = init(host, null, { renderer: 'svg' });
    else if (resize) figure.resize();
    figure.setOption(getOption(host), { lazyUpdate: !resize });
    rendered = revision;
  }
  new ResizeObserver(() => update(true)).observe(host);
  panel.querySelector('button').onclick = () => {
    update(true);
    if (!figure) return;
    const blob = new Blob([figure.renderToSVGString()], { type: 'image/svg+xml;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href, download: `nexarm-${panel.dataset.figure}.svg` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const refresh = () => update();
  refresh.resetZoom = () => figure?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  return refresh;
}

export function createTelemetry() {
  const history = Object.fromEntries(Object.entries(figures).filter(([, figure]) => figure.names).map(([key]) => [key, []]));
  let angles = null;
  let tcp = null;
  let revision = null;
  let refresh = 0;
  let archiveMode = false;
  let historyVersion = 0;
  const limitRows = [...document.querySelectorAll('[data-limit]')];
  const plots = [...document.querySelectorAll('[data-figure]')].map(panel => {
    const key = panel.dataset.figure;
    const option = key === 'range' ? () => rangeOption(angles)
      : key === 'workspace' ? host => reachOption(host, tcp)
      : () => timeOption(figures[key], history[key], Boolean(panel.closest('#page-control')));
    const version = key === 'range' ? () => angles?.join(',')
      : key === 'workspace' ? () => tcp?.slice(0, 2).join(',')
      : () => `${history[key].at(-1)?.stamp}:${historyVersion}:${displaySeconds}`;
    return mountFigure(panel, option, version);
  });

  function add(key, stamp, values) {
    const series = history[key];
    if (series.at(-1)?.stamp > stamp) series.length = 0;
    series.push({ stamp, values });
    if (key === 'sync' && series.length > 10000) series.shift();
  }

  function redraw() {
    if (refresh) return;
    refresh = setTimeout(() => {
      refresh = 0;
      plots.forEach(plot => plot());
    }, 145);
  }

  return {
    update(state) {
      const live = state.connected && state.angles;
      if (live && revision === state.revision) return;
      if (!live && angles === null) return;
      angles = live ? state.angles : null;
      tcp = live ? state.tcp : null;
      limitRows.forEach((row, i) => {
        const angle = angles?.[i];
        row.querySelector('output').textContent = angle == null ? '—' : angle.toFixed(1);
        row.classList.toggle('outside', angle != null && (angle < limits[i][0] - 0.01 || angle > limits[i][1] + 0.01));
      });
      if (live && !archiveMode) {
        revision = state.revision;
        add('angle', revision, angles);
        add('speed', revision, state.velocity);
        add('acceleration', revision, state.acceleration);
        add('tcp', revision, tcp);
        add('gripper', revision, [Math.max(0, Math.min(100, 100 * (1 - angles[5] / closedAngle)))]);
        add('error', revision, state.action_angles?.map((value, i) => value - angles[i]));
      } else if (!live && !archiveMode) {
        revision = null;
        Object.values(history).forEach(series => { series.length = 0; });
      }
      redraw();
    },
    camera(stamp, skew) {
      if (archiveMode) return;
      if (!Number.isFinite(skew)) return;
      add('sync', stamp, [skew]);
      redraw();
    },
    load(samples, events = []) {
      archiveMode = true;
      for (const key of ['angle', 'speed', 'acceleration', 'tcp', 'gripper', 'error', 'sync']) history[key] = [];
      for (const sample of samples) {
        const stamp = sample.stamp;
        const actual = sample.connected ? sample.angles : null;
        add('angle', stamp, actual);
        add('speed', stamp, sample.velocity);
        add('acceleration', stamp, sample.acceleration);
        add('tcp', stamp, sample.connected ? sample.tcp : null);
        add('gripper', stamp, actual ? [Math.max(0, Math.min(100, 100 * (1 - actual[5] / closedAngle)))] : null);
        add('error', stamp, actual && sample.action_angles ? sample.action_angles.map((v, i) => v - actual[i]) : null);
        add('sync', stamp, Number.isFinite(sample.images?.wrist?.pose_skew_ms) ? [sample.images.wrist.pose_skew_ms] : null);
      }
      operationEvents = events;
      historyVersion++;
      redraw();
    },
    window(seconds) { displaySeconds = seconds; historyVersion++; plots.forEach(plot => plot.resetZoom()); redraw(); },
  };
}

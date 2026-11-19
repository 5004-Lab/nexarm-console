import { init } from 'echarts/core';
import { matlabStyle } from './telemetry.js';
import { jointAngle } from './joint-units.js';
import joints from './joints.json';

export const trajectoryNames = [...joints.map((_, i) => `J${i + 1}`), '夹爪'];
const {base, axis, grid, textStyle, tip, colors} = matlabStyle;

export function trajectoryValues(row, command = false) {
  const values = command ? row.action : row['observation.state'];
  if (!values) return Array(7).fill(null);
  const encoder = command ? row.command_encoder : row.feedback_encoder;
  const jaw = joints[5];
  const pulse = encoder?.[5] ?? jaw.max - values[5] * (jaw.max - jaw.min);
  return [...values.slice(0, 5), jointAngle(5, pulse), values[5] * 100];
}

export function episodeChart(host, seek) {
  let figure, frames = [], cursorTime, showCommands = true;

  function cursor() {
    if (!figure || !frames.length || !Number.isFinite(cursorTime)) return;
    const x = figure.convertToPixel({xAxisIndex: 0}, cursorTime);
    const top = figure.convertToPixel({yAxisIndex: 1}, 100);
    const bottom = figure.convertToPixel({yAxisIndex: 1}, 0);
    const visible = Number.isFinite(x) && x >= grid.left && x <= figure.getWidth() - 66;
    figure.setOption({graphic: [{id: 'playhead', type: 'line', silent: true, invisible: !visible,
      shape: {x1: x, x2: x, y1: top, y2: bottom}, style: {stroke: '#26394b', lineWidth: 1, lineDash: [4, 3]}}]});
  }

  function render(reset = false) {
    if (!frames.length || !host.clientWidth || !host.clientHeight) return;
    if (!figure) {
      figure = init(host, null, {renderer: 'svg'});
      figure.on('datazoom', cursor);
      figure.getZr().on('click', event => {
        const pixel = [event.offsetX, event.offsetY];
        if (figure.containPixel({gridIndex: 0}, pixel)) seek(figure.convertFromPixel({xAxisIndex: 0}, event.offsetX));
      });
    }

    const series = [false, true].filter(command => !command || showCommands).flatMap(command => {
      const points = trajectoryNames.map(() => []);
      let previous = null;
      for (const row of frames) {
        const values = trajectoryValues(row, command);
        for (const [index, trace] of points.entries()) {
          if (previous && row.frame_index !== previous.frame_index + 1) trace.push([(row.timestamp + previous.timestamp) / 2, null]);
          trace.push([row.timestamp, values[index]]);
        }
        previous = row;
      }
      return points.map((data, index) => ({
        id: `${command ? 'cmd' : 'meas'}-${index}`, name: trajectoryNames[index],
        type: 'line', data, yAxisIndex: index === 6 ? 1 : 0, symbol: 'none', connectNulls: false,
        lineStyle: {color: colors[index], width: 1.55, type: command ? 'dashed' : 'solid', opacity: command ? .67 : 1},
        itemStyle: {color: colors[index]}, emphasis: {disabled: true},
      }));
    });

    const max = Math.max(frames.at(-1).timestamp, .2);
    figure.setOption({
      ...base, color: colors, grid: {...grid, right: 66, top: 43, bottom: 63},
      legend: {data: trajectoryNames, top: 8, right: 66, padding: [4, 8], itemWidth: 16,
        borderWidth: 1, borderColor: '#d3d7dc', inactiveColor: '#aab2ba', textStyle},
      xAxis: {...axis, type: 'value', min: 0, max, name: 'Episode 时间 (s)', nameLocation: 'middle', nameGap: 26},
      yAxis: [
        {...axis, type: 'value', scale: true, name: '关节角度 (°)', nameLocation: 'middle', nameGap: 43},
        {...axis, type: 'value', position: 'right', min: 0, max: 100, interval: 20, splitLine: {show: false},
          name: '夹爪开度 (%)', nameLocation: 'middle', nameGap: 39},
      ],
      dataZoom: [{id: 'episode-slider', type: 'slider', bottom: 4, height: 14, filterMode: 'none'},
        {id: 'episode-inside', type: 'inside', filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false}],
      tooltip: {...tip, trigger: 'axis', axisPointer: {type: 'line', snap: true},
        valueFormatter: amount => Number.isFinite(amount) ? amount.toFixed(2) : '—'},
      series,
    }, reset ? {notMerge: true} : {replaceMerge: ['series']});
    cursor();
  }

  new ResizeObserver(() => {
    if (figure && host.clientWidth && host.clientHeight) {
      figure.resize();
      cursor();
    } else render();
  }).observe(host);

  return {
    load(rows) {
      frames = rows;
      cursorTime = undefined;
      if (!frames.length) { figure?.clear(); return; }
      render(true);
    },
    position(value) { cursorTime = value; cursor(); },
    commands(show) { showCommands = show; render(); },
    download(index) {
      if (!figure || !frames.length) return;
      const url = URL.createObjectURL(new Blob([figure.renderToSVGString()], {type: 'image/svg+xml;charset=utf-8'}));
      Object.assign(document.createElement('a'), {href: url, download: `episode-${index}-trajectory.svg`}).click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    },
  };
}

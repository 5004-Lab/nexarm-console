export const toScene = ([x, y, z]) => [x / 1000, z / 1000, -y / 1000];
export const fromScene = ([x, y, z]) => [x * 1000, -z * 1000, y * 1000].map(value => Math.round(value * 10) / 10);
export const targetKey = xyz => xyz.every(Number.isFinite) ? xyz.map(value => value.toFixed(1)).join(',') : '';
export function nudgeTarget(xyz, axis, direction, step) {
  if (!['X', 'Y', 'Z'].includes(axis) || ![-1, 1].includes(direction) || ![1, 5, 10].includes(step)) throw Error('无效的目标微调参数');
  return xyz.map((value, i) => Math.round((value + (i === 'XYZ'.indexOf(axis) ? direction * step : 0)) * 10) / 10);
}

import joints from './joints.json';

export function jointAngle(i, position) {
  const joint = joints[i];
  return (position - joint.zero) * joint.sign * 180 / (Math.PI * joint.ticks);
}

export function jointPosition(i, degrees) {
  const joint = joints[i];
  return joint.zero + degrees * joint.ticks * joint.sign * Math.PI / 180;
}

export function angleSpeed(i, speed) {
  return speed * 180 / (Math.PI * joints[i].ticks);
}

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import URDFLoader from 'urdf-loader';
import joints from './joints.json';
import workcell from './workcell.json';
import sampledReach from './reach.json';

export function createTwin(host, onLoad) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    onLoad('此浏览器无法创建 WebGL 视口');
    return { update() {}, view() {}, pick() {}, target() {}, setPath() {}, setTrace() {} };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.domElement.setAttribute('aria-label', 'NexArm 三维数字孪生');
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf7faff);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.012, 12);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.34;
  controls.maxDistance = 2.5;
  controls.maxPolarAngle = Math.PI * 0.52;
  const views = {
    iso: [0.64, 0.52, 0.67],
    front: [0.001, 0.25, 0.98],
    top: [0, 1.85, 0.001],
  };
  function view(name) {
    camera.position.set(...views[name]);
    controls.target.set(0, 0.19, 0);
    if (name === 'top') controls.target.y = 0;
    controls.update();
  }
  view('iso');

  scene.add(new THREE.HemisphereLight(0xffffff, 0x93a1b4, 2.4));
  const key = new THREE.DirectionalLight(0xfff8eb, 3.1);
  key.position.set(0.65, 1.4, 0.62);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -0.7, right: 0.7, top: 0.7, bottom: -0.7, near: 0.1, far: 3 });
  key.shadow.normalBias = 0.007;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xd7e5ff, 2.4);
  rim.position.set(-0.8, 0.6, -0.5);
  scene.add(rim);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.21 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(1.1, 22, 0x9aaabd, 0xcbd6e4);
  grid.position.y = 0.0005;
  grid.material.transparent = true;
  grid.material.opacity = 0.82;
  scene.add(grid);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.135, 0.137, 90),
    new THREE.MeshBasicMaterial({ color: 0x607d9e, transparent: true, opacity: 0.35 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.001;
  scene.add(ring);

  const origin = new THREE.Vector3(0, 0.002, 0);
  for (const [direction, color, label] of [
    [[1, 0, 0], 0xbe4239, 'X'], [[0, 0, -1], 0x28815a, 'Y'], [[0, 1, 0], 0x0072bd, 'Z'],
  ]) {
    const vector = new THREE.Vector3(...direction);
    scene.add(new THREE.ArrowHelper(vector, origin, 0.11, color, 0.014, 0.009));
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = labelCanvas.height = 64;
    const ctx = labelCanvas.getContext('2d');
    ctx.font = 'bold 46px ui-monospace, monospace';
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, 32, 49);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(labelCanvas) }));
    sprite.position.copy(origin).addScaledVector(vector, 0.125);
    sprite.scale.setScalar(0.033);
    scene.add(sprite);
  }

  const dot = (radius, color) => new THREE.Mesh(
    new THREE.SphereGeometry(radius, 18, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
  const flange = dot(0.007, 0x0072bd);
  flange.position.fromArray(workcell.tool_offset_mm).multiplyScalar(0.001);
  flange.renderOrder = 2;
  const targetDot = dot(0.009, 0xdd6b10);
  targetDot.visible = false;
  targetDot.renderOrder = 3;
  scene.add(targetDot);
  const trajectory = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x0072bd }));
  trajectory.visible = false;
  scene.add(trajectory);
  const trace = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8663b8, transparent: true, opacity: 0.8 }));
  scene.add(trace);

  const slice = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
    color: 0x0072bd, size: 4, sizeAttenuation: false, opacity: 0.65, transparent: true, depthTest: false,
  }));
  slice.visible = false;
  scene.add(slice);
  const coordinates = ([x, y, z]) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000);
  let sliceSamples = [];
  let pickHeight = 0;
  const picker = new THREE.Raycaster();
  let pickCallback;
  let pointerDown;
  renderer.domElement.addEventListener('pointerdown', event => {
    pointerDown = event.button === 0 ? [event.clientX, event.clientY] : null;
  });
  renderer.domElement.addEventListener('pointerup', event => {
    if (!pickCallback || !pointerDown || Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    picker.setFromCamera(new THREE.Vector2(
      (event.clientX - rect.left) * 2 / rect.width - 1, 1 - (event.clientY - rect.top) * 2 / rect.height,
    ), camera);
    const point = picker.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -pickHeight / 1000), new THREE.Vector3());
    if (!point) return;
    const xy = [Math.round(point.x * 10000) / 10, -Math.round(point.z * 10000) / 10, pickHeight];
    const nearby = sliceSamples.map(candidate => [Math.hypot(xy[0] - candidate[0], xy[1] - candidate[1]), candidate])
      .filter(([distance]) => distance <= 55).sort((a, b) => a[0] - b[0]).slice(0, 3);
    pickCallback(nearby.length ? [xy, ...nearby.map(item => item[1])] : []);
  });
  for (const obstacle of workcell.obstacles) {
    const lower = coordinates(obstacle.min_mm);
    const upper = coordinates(obstacle.max_mm);
    const size = upper.clone().sub(lower);
    const geometry = new THREE.BoxGeometry(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z));
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0xb35f15 }));
    outline.position.copy(lower).add(upper).multiplyScalar(0.5);
    scene.add(outline);
  }

  let robot;
  let readings;
  let error = false;
  const manager = new THREE.LoadingManager();
  manager.onLoad = () => {
    if (!error) onLoad('');
  };
  manager.onError = () => {
    error = true;
    onLoad('部分 3D 模型文件加载失败');
  };
  const loader = new URDFLoader(manager);
  const metal = new THREE.MeshStandardMaterial({ color: 0x788593, metalness: 0.46, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.25, roughness: 0.44 });
  const gripper = new THREE.MeshStandardMaterial({ color: 0x9da6b1, metalness: 0.35, roughness: 0.39 });
  const stl = new STLLoader(manager);
  loader.loadMeshCb = async (url, manager, _material, done) => {
    manager.itemStart(url);
    try {
      let buffer;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw Error(`无法读取 ${url}（${response.status}）`);
          buffer = await response.arrayBuffer();
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 180 * (attempt + 1)));
        }
      }
      const geometry = stl.parse(buffer);
      const name = url.split('/').at(-1);
      const material = /jaw|gripper_base/.test(name) ? gripper : /camera|base_link/.test(name) ? dark : metal;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      done(mesh);
    } catch (error) {
      manager.itemError(url);
      done(null, error);
    } finally {
      manager.itemEnd(url);
    }
  };

  function applyReadings() {
    if (!robot || !readings) return;
    const values = Object.fromEntries(joints.map((joint, i) => [
      joint.joint, joint.sign * (readings[i][0] - joint.zero) / joint.ticks,
    ]));
    robot.setJointValues(values);
  }

  loader.load('/model/nexarm.urdf', model => {
    robot = model;
    robot.rotation.x = -Math.PI / 2;
    for (const joint of Object.values(robot.joints)) joint.ignoreLimits = true;
    robot.links.gripper_link.add(flange);
    scene.add(robot);
    applyReadings();
  }, undefined, () => onLoad('无法加载 NexArm 三维模型'));

  const resize = new ResizeObserver(() => {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  return {
    update(value) {
      readings = value;
      applyReadings();
    },
    view,
    pick(height, callback) {
      const enabled = height !== null;
      pickCallback = enabled ? callback : null;
      controls.enableRotate = !enabled;
      slice.visible = enabled;
      if (enabled) {
        pickHeight = height;
        sliceSamples = sampledReach.filter(([x, y, z]) =>
          Math.abs(z - height) <= 18 && Math.hypot(x, y, height) <= workcell.max_reach_mm
        ).map(([x, y]) => [x, y, height]);
        slice.geometry.dispose();
        slice.geometry = new THREE.BufferGeometry().setFromPoints(sliceSamples.map(coordinates));
        controls.target.y = height / 1000;
        camera.position.set(0, height / 1000 + 1.82, 0.001);
        controls.update();
      }
      renderer.domElement.style.cursor = enabled ? 'crosshair' : '';
      return sliceSamples.length;
    },
    target(point) {
      targetDot.visible = point !== null;
      if (point) targetDot.position.copy(coordinates(point));
    },
    setPath(points) {
      trajectory.geometry.dispose();
      trajectory.geometry = new THREE.BufferGeometry().setFromPoints(points.map(coordinates));
      trajectory.visible = points.length > 1;
    },
    setTrace(points) {
      trace.geometry.dispose();
      trace.geometry = new THREE.BufferGeometry().setFromPoints(points.map(coordinates));
      trace.visible = points.length > 1;
    },
  };
}

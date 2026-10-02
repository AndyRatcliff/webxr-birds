// WebXR recreation of AllFlocks.unity: GPU_Flock_Final (GPUFlock + Metronome + BringFlockForward)
// steered by GazeControlled through the invisible InsideOutHemisphere colliders.

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import GUI from 'lil-gui';
import { GPUFlock } from './flock.js';
import { Choreography } from './choreography.js';
import { GazeTracker } from './gaze.js';
import { createSky } from './sky.js';

// Unity is left-handed, three.js right-handed: negate Z for every scene coordinate.
const u2t = (x, y, z) => new THREE.Vector3(x, y, -z);

// Values lifted from AllFlocks.unity / GPU_Flock.prefab
const SCENE = {
  cameraPosition: u2t(133.48149, 6.503111, 8.789683), // Main Camera
  cameraYaw: Math.PI / 2,                              // Unity Y -90 -> looking down -X
  fov: 45, near: 0.3, far: 1000,
  domeCenter: u2t(140, 0, 0),                          // InsideOutHemisphere x2 (both upper domes)
  domeRadius: 48.2386,                                 // 1 m mesh * 48.2386 scale
  flockStart: u2t(-100, 1, 10),                        // BringFlockForward.startPos
  flockEnd: u2t(90, 1, 10),                            // BringFlockForward.endPos
  flockApproachSpeed: 0.2,
  lightTravel: u2t(0.46853, 0.34911, -0.81154),        // Directional light forward (Euler 200.4, -30, 0)
  fogColor: [0.75686276, 0.7019608, 0.70980394],
  fogNear: 15, fogFar: 80,
};

// ---------------------------------------------------------------- settings
const query = new URLSearchParams(location.search);
const standalone = /OculusBrowser|Quest|Pico|Android|Mobile/i.test(navigator.userAgent);
const intParam = (k, d) => (query.has(k) && !Number.isNaN(parseInt(query.get(k), 10)) ? parseInt(query.get(k), 10) : d);
const settings = {
  boids: intParam('boids', standalone ? 8192 : 28000),  // BoidsCount 28000 in the Unity scene
  samples: intParam('samples', standalone ? 256 : 2048), // neighbours checked per boid per frame, 0 = all
  choreography: query.get('choreography') !== '0',
  reticle: query.get('reticle') === '1',
  mouseGaze: false,
  model: (query.get('model') || 'sparrow').toLowerCase(),
};

const MODELS = {
  sparrow: { label: 'Sparrow', json: 'assets/sparrow.json', map: 'assets/sparrow.jpg', frameSpeedScale: 1 },
  // Larger wing travel reads faster at the same 16-frame rate — slow the cycle.
  bat: { label: 'Bat', json: 'assets/bat.json', map: 'assets/bat.png', frameSpeedScale: 0.55 },
};
if (!MODELS[settings.model]) settings.model = 'sparrow';
// Bust HTTP cache when rebaking assets during local iteration.
const ASSET_VER = '13';

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const fogColor = new THREE.Color().setRGB(...SCENE.fogColor, THREE.SRGBColorSpace);
scene.fog = new THREE.Fog(fogColor, SCENE.fogNear, SCENE.fogFar);

const camera = new THREE.PerspectiveCamera(SCENE.fov, window.innerWidth / window.innerHeight, SCENE.near, SCENE.far);
const look = { yaw: SCENE.cameraYaw, pitch: 0 };

const sky = createSky();
scene.add(sky);

// Unity intensity 1 == three.js intensity PI (three's Lambert term divides by PI). Ambient is flat black.
const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
sun.position.copy(SCENE.lightTravel).multiplyScalar(-100);
scene.add(sun);

const reticle = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 8),
  new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.7, depthTest: false }));
reticle.renderOrder = 10;
scene.add(reticle);

// ---------------------------------------------------------------- state
const gaze = new GazeTracker({ socketUrl: query.get('gazeSocket') });
const choreo = new Choreography({ bpm: 128 });
const flockParams = GPUFlock.defaultParams(); // shared with the GUI
const flockRoot = SCENE.flockStart.clone();   // GPU_Flock transform
const targetLocal = new THREE.Vector3();      // "Sphere (1)" localPosition under GPU_Flock
const target = new THREE.Vector3();           // GPUFlock.Target -> FlockPosition
const hit = new THREE.Vector3();
const music = document.getElementById('music');
let audioOk = true;
let started = false;
let clockStart = 0;
let flock = null;
let species = null;   // baked mesh JSON (sparrow/bat)
let speciesMap = null;
const speciesCache = new Map(); // model id -> { json, map }

music.addEventListener('error', () => { audioOk = false; });

/** Physics.Raycast against the inward-facing dome: only the far root faces the ray, and only y >= 0 exists. */
function intersectDome(ray, out) {
  const oc = ray.origin.clone().sub(SCENE.domeCenter);
  const b = oc.dot(ray.direction);
  const c = oc.lengthSq() - SCENE.domeRadius * SCENE.domeRadius;
  const h = b * b - c;
  if (h < 0) return false;
  const t = -b + Math.sqrt(h);
  if (t <= 0) return false;
  out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
  return out.y >= SCENE.domeCenter.y;
}

function buildFlock() {
  if (flock) {
    scene.remove(flock.mesh);
    flock.dispose();
  }
  flock = new GPUFlock(renderer, {
    count: settings.boids,
    sparrow: species,
    map: speciesMap,
    params: flockParams,
    speedLinkedFlap: settings.model === 'bat',
    frameSpeedScale: MODELS[settings.model]?.frameSpeedScale ?? 1,
  });
  flock.samplesPerBoid = settings.samples;
  scene.add(flock.mesh);
  flock.reset(flockRoot);
  window.andyBirds = { flock, renderer, settings }; // console/debug handle
}

async function loadSpecies(id) {
  if (!MODELS[id]) id = 'sparrow';
  if (speciesCache.has(id)) {
    const cached = speciesCache.get(id);
    species = cached.json;
    speciesMap = cached.map;
    settings.model = id;
    return;
  }
  const def = MODELS[id];
  const [json, map] = await Promise.all([
    fetch(`${def.json}?v=${ASSET_VER}`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${def.json}`);
      return r.json();
    }),
    new THREE.TextureLoader().loadAsync(`${def.map}?v=${ASSET_VER}`),
  ]);
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = false;
  map.anisotropy = 4;
  speciesCache.set(id, { json, map });
  species = json;
  speciesMap = map;
  settings.model = id;
}

async function setModel(id) {
  if (id === settings.model && species) return;
  await loadSpecies(id);
  const url = new URL(location.href);
  if (id === 'sparrow') url.searchParams.delete('model');
  else url.searchParams.set('model', id);
  history.replaceState(null, '', url);
  buildFlock();
}

function restart() {
  flockRoot.copy(SCENE.flockStart);
  targetLocal.set(0, 0, 0);
  choreo.reset();
  Object.assign(flockParams, GPUFlock.defaultParams());
  buildFlock();
}

function songTime() {
  if (!started) return 0;
  return audioOk ? music.currentTime : (performance.now() - clockStart) / 1000;
}

function start() {
  restart();
  started = true;
  document.getElementById('overlay').classList.add('hidden');
  clockStart = performance.now();
  music.currentTime = 0;
  if (audioOk) {
    music.play().catch(() => { audioOk = false; clockStart = performance.now(); });
  }
}

// ---------------------------------------------------------------- XR rig
const Y_AXIS = new THREE.Vector3(0, 1, 0);
renderer.xr.addEventListener('sessionstart', () => {
  // Put the viewer's starting head pose where the Unity Main Camera sits, facing the flock.
  const worldFromLocal = new THREE.Matrix4().compose(
    SCENE.cameraPosition, new THREE.Quaternion().setFromAxisAngle(Y_AXIS, SCENE.cameraYaw), new THREE.Vector3(1, 1, 1));
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  worldFromLocal.invert().decompose(p, q, new THREE.Vector3());
  const base = renderer.xr.getReferenceSpace();
  renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(
    new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w })));
});

// ---------------------------------------------------------------- desktop controls
let dragging = false;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
renderer.domElement.addEventListener('pointermove', (e) => {
  gaze.mouseNdc = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 };
  if (!dragging) return;
  look.yaw -= e.movementX * 0.003;
  look.pitch = THREE.MathUtils.clamp(look.pitch - e.movementY * 0.003, -1.4, 1.4);
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- GUI / HUD
const gui = new GUI({ title: 'GPU Flock' });
gui.close();
gui.add(settings, 'model', Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [v.label, k])))
  .name('Species')
  .onChange((id) => { setModel(id).catch(console.error); });
const simFolder = gui.addFolder('Simulation');
simFolder.add(settings, 'boids', 256, 65536, 256).name('BoidsCount').onFinishChange(() => restart());
simFolder.add(settings, 'samples', 0, 8192, 64).name('neighbour samples (0 = all)')
  .onChange((v) => { if (flock) flock.samplesPerBoid = v; });
const choreoFolder = gui.addFolder('Metronome');
choreoFolder.add(settings, 'choreography').name('drive params from music');
for (const [key, max] of [['NeighbourDistance', 50], ['BoidSpeed', 20], ['BoidSpeedVariation', 1], ['RotationSpeed', 20], ['BoidFrameSpeed', 30]]) {
  choreoFolder.add(flockParams, key, 0, max, 0.01).listen();
}
const gazeFolder = gui.addFolder('Gaze');
gazeFolder.add(settings, 'mouseGaze').name('mouse = eye tracker').onChange((v) => { gaze.useMouse = v; });
gazeFolder.add(settings, 'reticle').name('show target');
gui.add({ restart: start }, 'restart').name('Restart (with music)');

const hud = document.getElementById('hud');
let fps = 60;
let hudTimer = 0;
function updateHud(dt) {
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.25;
  const stride = settings.samples > 0 ? Math.max(1, Math.ceil(flock.count / settings.samples)) : 1;
  const p = flock.params;
  const speciesName = MODELS[settings.model]?.label || settings.model;
  hud.textContent =
    `gaze: ${gaze.source}${gaze.bridge.url ? ` [bridge ${gaze.bridge.status}]` : ''}  |  ` +
    `${speciesName} × ${flock.count}, ${stride === 1 ? 'all neighbours' : `1/${stride} neighbours`}  |  ` +
    `bar ${choreo.beatCount}  ND ${p.NeighbourDistance.toFixed(2)}  speed ${p.BoidSpeed.toFixed(2)}  ` +
    `var ${p.BoidSpeedVariation.toFixed(2)}  |  ${fps.toFixed(0)} fps`;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();

function frame(time, xrFrame) {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (!renderer.xr.isPresenting) {
    camera.position.copy(SCENE.cameraPosition);
    camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }

  // BringFlockForward.Update
  flockRoot.lerp(SCENE.flockEnd, Math.min(dt * SCENE.flockApproachSpeed, 1));

  // GazeControlled.Update: move the target to the gaze hit; otherwise it rides along with GPU_Flock
  const ray = gaze.update({
    camera,
    xrFrame: renderer.xr.isPresenting ? xrFrame : null,
    refSpace: renderer.xr.isPresenting ? renderer.xr.getReferenceSpace() : null,
  });
  if (intersectDome(ray, hit)) targetLocal.copy(hit).sub(flockRoot);
  target.copy(flockRoot).add(targetLocal);

  // Metronome.Update
  if (started && settings.choreography) choreo.update(songTime(), dt, flockParams);

  // GPUFlock.Update + LateUpdate
  flock.step(dt, target);

  sky.position.copy(gaze.headPosition);

  reticle.visible = settings.reticle;
  reticle.position.copy(target);
  reticle.scale.setScalar(Math.max(0.05, target.distanceTo(gaze.headPosition) * 0.004));

  renderer.render(scene, camera);
  updateHud(dt);
}

// ---------------------------------------------------------------- boot
async function boot() {
  await loadSpecies(settings.model);
  buildFlock();

  const vrButton = VRButton.createButton(renderer);
  vrButton.addEventListener('click', () => { if (navigator.xr) start(); });
  document.getElementById('buttons').appendChild(vrButton);
  // VRButton positions itself absolutely; let our overlay lay it out instead.
  vrButton.style.position = 'static';
  vrButton.style.left = vrButton.style.bottom = '';

  document.getElementById('start').addEventListener('click', start);
  document.getElementById('loading').remove();
  renderer.setAnimationLoop(frame);
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('loading').textContent = `Failed to start: ${err.message}`;
});

/**
 * Bake bat-fixed.glb wing_flap into assets/bat.json (+ bat.png) for the GPU flock.
 *
 *   cd tools && npm run bake:bat
 *
 * Source: BAT_GLB env or c:/Users/araf/Downloads/bat-fixed.glb
 * Merges multi-material skinned meshes. Orients nose to +Z for the flock shader.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Blob } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

globalThis.self = globalThis;
globalThis.Blob = Blob;
const blobStore = new Map();
globalThis.URL.createObjectURL = (blob) => {
  const id = `blob:node-${blobStore.size}`;
  blobStore.set(id, blob);
  return id;
};
globalThis.URL.revokeObjectURL = (id) => blobStore.delete(id);
globalThis.Image = class {
  set src(v) {
    Promise.resolve().then(() => this.onload?.(new Event('load')));
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const glbPath = process.env.BAT_GLB || path.resolve('c:/Users/araf/Downloads/bat-fixed.glb');
const outJson = path.resolve(here, '../assets/bat.json');
const outPng = path.resolve(here, '../assets/bat.png');
const TARGET_SPAN = 0.58; // match sparrow body length (~0.58 on Z)
const FRAMES = 16;

const buf = fs.readFileSync(glbPath);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  '',
);

const meshes = [];
gltf.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
if (!meshes.length) throw new Error('No SkinnedMesh in ' + glbPath);

const clip =
  gltf.animations.find((a) => a.name === 'wing_flap') ||
  gltf.animations.find((a) => a.name === 'fly') ||
  gltf.animations[0];
if (!clip) throw new Error('No animation clip found');

const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(clip).play();

// Align head→forward to flock +Z using bind/rest bones (glTF nose is roughly −Z).
mixer.setTime(0);
gltf.scene.updateMatrixWorld(true);
const bonePos = (name) => {
  let b;
  gltf.scene.traverse((o) => { if (o.isBone && o.name === name) b = o; });
  if (!b) throw new Error('Missing bone ' + name);
  return b.getWorldPosition(new THREE.Vector3());
};
// Body root vs head tip: Box001 body, Box002 head
const body = bonePos('Box001_01');
const head = bonePos('Box002_02');
let forward = head.clone().sub(body);
if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
forward.normalize();
console.log('native forward (body→head)', forward.toArray().map((x) => +x.toFixed(3)));

// Build an upright basis: nose → +Z, keep belly toward −Y/+Y world up.
const zAxis = forward.clone().normalize();
const worldUp = new THREE.Vector3(0, 1, 0);
let xAxis = worldUp.clone().cross(zAxis);
if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
xAxis.normalize();
const yAxis = zAxis.clone().cross(xAxis).normalize();
// basis maps flock(+X,+Y,+Z) → native(xAxis,yAxis,zAxis); invert to orient mesh into flock space.
const orient = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).invert();
console.log('orient maps forward to', forward.clone().applyMatrix4(orient).toArray().map((x) => +x.toFixed(3)));
console.log('orient maps up to', worldUp.clone().applyMatrix4(orient).toArray().map((x) => +x.toFixed(3)));

function skinnedPositions() {
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  let total = 0;
  for (const mesh of meshes) {
    mesh.skeleton.update();
    const n = mesh.geometry.attributes.position.count;
    const arr = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(orient);
      arr.set([v.x, v.y, v.z], i * 3);
    }
    parts.push({ mesh, arr, count: n });
    total += n;
  }
  return { parts, total };
}

// Scale so the longest AABB axis across frame 0 equals TARGET_SPAN
mixer.setTime(0);
const probe = skinnedPositions();
let bMin = [1e9, 1e9, 1e9];
let bMax = [-1e9, -1e9, -1e9];
for (const { arr, count } of probe.parts) {
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = arr[i * 3 + k];
      bMin[k] = Math.min(bMin[k], v);
      bMax[k] = Math.max(bMax[k], v);
    }
  }
}
const rawSize = bMax.map((m, i) => m - bMin[i]);
const scale = TARGET_SPAN / Math.max(...rawSize, 1e-6);
console.log(`meshes ${meshes.length}, verts ${probe.total}, rawSize`, rawSize.map((x) => +x.toFixed(3)), 'scale', +scale.toFixed(4));

// Build combined index + uv once from rest geometry (topology fixed)
const index = [];
const uv = [];
let vBase = 0;
for (const mesh of meshes) {
  const geo = mesh.geometry;
  const idx = geo.index;
  for (let i = 0; i < idx.count; i++) index.push(idx.getX(i) + vBase);
  if (geo.attributes.uv) {
    uv.push(...geo.attributes.uv.array);
  } else {
    for (let i = 0; i < geo.attributes.position.count; i++) uv.push(0.5, 0.5);
  }
  vBase += geo.attributes.position.count;
}

const positions = [];
const normals = [];
const duration = clip.duration || 16 / 24;
const vertexCount = probe.total;

// Sample all frames, then center on the average bounding-box center so the
// mesh sits on the boid origin (sparrow bake is already roughly centered).
const framePositions = [];
for (let f = 0; f < FRAMES; f++) {
  mixer.setTime((f / FRAMES) * duration);
  const { parts } = skinnedPositions();
  const framePos = new Float32Array(vertexCount * 3);
  let o = 0;
  for (const { arr } of parts) {
    for (let i = 0; i < arr.length; i++) framePos[o++] = arr[i] * scale;
  }
  framePositions.push(framePos);
}

// Reduce wing-flap travel by 20%: scale each frame's offset from the mean pose.
const FLAP_AMOUNT = 0.8;
// No full upstroke: allow 10% of the (already damped) upward travel above level.
const UP_FLAP_AMOUNT = 0.2;
const mean = new Float32Array(vertexCount * 3);
for (const framePos of framePositions) {
  for (let i = 0; i < mean.length; i++) mean[i] += framePos[i];
}
for (let i = 0; i < mean.length; i++) mean[i] /= FRAMES;
for (const framePos of framePositions) {
  for (let i = 0; i < framePos.length; i++) {
    framePos[i] = mean[i] + FLAP_AMOUNT * (framePos[i] - mean[i]);
  }
  // Clamp upstroke to level (mean Y); leave downstroke alone.
  for (let i = 0; i < vertexCount; i++) {
    const yi = i * 3 + 1;
    const dy = framePos[yi] - mean[yi];
    if (dy > 0) framePos[yi] = mean[yi] + UP_FLAP_AMOUNT * dy;
  }
}
console.log(`flap amount ${FLAP_AMOUNT}, up flap ${UP_FLAP_AMOUNT}`);

let cMin = [1e9, 1e9, 1e9];
let cMax = [-1e9, -1e9, -1e9];
for (const framePos of framePositions) {
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = framePos[i * 3 + k];
      cMin[k] = Math.min(cMin[k], v);
      cMax[k] = Math.max(cMax[k], v);
    }
  }
}
const center = cMin.map((m, i) => (m + cMax[i]) * 0.5);
console.log('center offset', center.map((x) => +x.toFixed(4)));

for (const framePos of framePositions) {
  for (let i = 0; i < vertexCount; i++) {
    framePos[i * 3] -= center[0];
    framePos[i * 3 + 1] -= center[1];
    framePos[i * 3 + 2] -= center[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(framePos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  positions.push(...framePos);
  normals.push(...g.attributes.normal.array);
}

const round = (a, d = 5) => Array.from(a, (x) => +Number(x).toFixed(d));
fs.writeFileSync(outJson, JSON.stringify({
  source: glbPath,
  note: 'Merged multi-material bat. wing_flap bake. +Y up, +Z = nose (180° Y from glTF −Z).',
  vertexCount,
  frames: FRAMES,
  clipDuration: duration,
  clipName: clip.name,
  index,
  uv: round(uv),
  positions: round(positions),
  normals: round(normals, 4),
}));
console.log(`Wrote ${outJson}: ${vertexCount} verts, ${index.length / 3} tris, ${FRAMES} frames`);

// Synthetic dark-brown albedo (Blender mats were procedural; sidecar PNG is a render)
const w = 128;
const h = 128;
const raw = Buffer.alloc(w * h * 3);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const n = ((x * 13 + y * 7) % 11) - 5;
    // Slightly lighter near edges (membrane) vs center (body) via UV-ish radius
    const u = x / (w - 1);
    const v = y / (h - 1);
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const membrane = edge < 0.2 ? 1.4 : 1.0;
    raw[i] = Math.min(255, Math.max(0, (42 + n) * membrane));
    raw[i + 1] = Math.min(255, Math.max(0, (26 + n) * membrane));
    raw[i + 2] = Math.min(255, Math.max(0, (20 + n) * membrane * 0.9));
  }
}
const rows = Buffer.alloc((w * 3 + 1) * h);
for (let y = 0; y < h; y++) {
  rows[y * (w * 3 + 1)] = 0;
  raw.copy(rows, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
}
const compressed = deflateSync(rows);
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(outPng, png);
console.log('Wrote', outPng);

fs.copyFileSync(glbPath, path.resolve(here, '../assets/bat-source.glb'));
console.log('Copied assets/bat-source.glb');

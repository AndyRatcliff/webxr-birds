// Offline equivalent of GPUFlock.GenerateSkinnedAnimationForGPUBuffer():
// converts Assets/Common/flying_sparrow.fbx (FBX 6.0, which three.js cannot read),
// samples the skinned wing-flap clip into NbFrames vertex frames and writes
// ../assets/sparrow.json for the browser.
//
//   cd WebXR/tools && npm install && npm run bake

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fbxPath = path.resolve(here, '../../Assets/Common/flying_sparrow.fbx');
const outPath = path.resolve(here, '../assets/sparrow.json');
const tmpBase = path.resolve(here, '.sparrow');

// Unity import settings (flying_sparrow.fbx.meta): globalScale 0.25.
// FBX2glTF keeps the raw file units, which are 4x the Unity units.
const UNITY_SCALE = 0.25;
const CLIP_FPS = 24; // 20 keys over 0.79 s

// 1. FBX -> GLB
const exe = {
  win32: 'Windows_NT/FBX2glTF.exe', darwin: 'Darwin/FBX2glTF', linux: 'Linux/FBX2glTF',
}[process.platform];
execFileSync(path.resolve(here, 'node_modules/fbx2gltf/bin', exe),
  ['--binary', '-i', fbxPath, '-o', tmpBase], { stdio: 'inherit' });

// 2. Drop the dangling texture reference FBX2glTF emits (the JPG is loaded separately).
const glb = fs.readFileSync(tmpBase + '.glb');
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
delete json.images; delete json.textures; delete json.samplers;
for (const m of json.materials || []) delete m.pbrMetallicRoughness?.baseColorTexture;
let jsonChunk = Buffer.from(JSON.stringify(json));
jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc((4 - (jsonChunk.length % 4)) % 4, 0x20)]);
const binChunk = glb.subarray(20 + jsonLen);
const header = Buffer.alloc(20);
header.write('glTF', 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(20 + jsonChunk.length + binChunk.length, 8);
header.writeUInt32LE(jsonChunk.length, 12); header.write('JSON', 16);
const clean = Buffer.concat([header, jsonChunk, binChunk]);
fs.rmSync(tmpBase + '.glb');

// 3. Sample the animation.
const gltf = await new GLTFLoader().parseAsync(
  clean.buffer.slice(clean.byteOffset, clean.byteOffset + clean.byteLength), '');
let mesh;
gltf.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
const clip = gltf.animations[0];
const geo = mesh.geometry;
const vertexCount = geo.attributes.position.count;

// Unity: NbFrames = Mathf.ClosestPowerOfTwo(frameRate * length) -> 16
const keyCount = Math.round(clip.duration * CLIP_FPS);
const frames = 2 ** Math.round(Math.log2(keyCount));
// The clip is a closed loop (last key == first key), so sample [0, duration).
const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(clip).play();

const positions = [];
const normals = [];
const v = new THREE.Vector3();
for (let f = 0; f < frames; f++) {
  mixer.setTime((f / frames) * clip.duration);
  gltf.scene.updateMatrixWorld(true);
  const framePos = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    mesh.getVertexPosition(i, v).multiplyScalar(UNITY_SCALE);
    framePos.set([v.x, v.y, v.z], i * 3);
  }
  // FBX has no normals ("Repaired empty normals"), so derive them per frame like Unity's import would.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(framePos, 3));
  g.setIndex(geo.index);
  g.computeVertexNormals();
  positions.push(...framePos);
  normals.push(...g.attributes.normal.array);
}

const round = (a, d = 5) => Array.from(a, (x) => +x.toFixed(d));
fs.writeFileSync(outPath, JSON.stringify({
  source: 'Assets/Common/flying_sparrow.fbx',
  note: 'Vertex-animation bake (glTF axes: +Y up, +Z = beak). positions/normals are [frame][vertex][xyz].',
  vertexCount,
  frames,
  clipDuration: clip.duration,
  index: Array.from(geo.index.array),
  uv: round(geo.attributes.uv.array),
  positions: round(positions),
  normals: round(normals, 4),
}));
console.log(`Wrote ${outPath}: ${vertexCount} verts, ${geo.index.count / 3} tris, ${frames} frames`);

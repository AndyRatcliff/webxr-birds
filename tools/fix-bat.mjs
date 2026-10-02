/**
 * Fix Sketchfab bat.glb mess: tiny, far from origin, nested unit-scale.
 * Centers at origin and normalizes so the largest axis is 1. Preserves skinning.
 *
 *   node fix-bat.mjs "bat (1).glb" [bat-fixed.glb]
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { center, getBounds, prune, dedup } from '@gltf-transform/functions';

const input = process.argv[2];
const output = process.argv[3] || path.join(path.dirname(input), 'bat-fixed.glb');
if (!input) {
  console.error('Usage: node fix-bat.mjs <bat.glb> [out.glb]');
  process.exit(1);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();
const scene = root.listScenes()[0];

const before = getBounds(scene);
const beforeSize = [
  before.max[0] - before.min[0],
  before.max[1] - before.min[1],
  before.max[2] - before.min[2],
];
console.log('before center', before);
console.log('before size', beforeSize);

// Remove empty/useless clip
for (const anim of [...root.listAnimations()]) {
  if (anim.getName() === 'NOTHING') anim.dispose();
}

// Move world-space bbox center to origin (adds a pivot translation).
await doc.transform(center({ pivot: 'center' }));

// Uniform-scale scene roots so max axis == 1 (keeps skinning valid).
const mid = getBounds(scene);
const ext = [
  mid.max[0] - mid.min[0],
  mid.max[1] - mid.min[1],
  mid.max[2] - mid.min[2],
];
const maxDim = Math.max(...ext) || 1;
const norm = 1 / maxDim;
console.log('normalize by', norm);

for (const node of scene.listChildren()) {
  const s = node.getScale();
  node.setScale([s[0] * norm, s[1] * norm, s[2] * norm]);
  const t = node.getTranslation();
  node.setTranslation([t[0] * norm, t[1] * norm, t[2] * norm]);
}

await doc.transform(dedup(), prune());

const after = getBounds(scene);
console.log('after', after);
console.log('after size', [
  after.max[0] - after.min[0],
  after.max[1] - after.min[1],
  after.max[2] - after.min[2],
]);

await io.write(output, doc);
console.log('wrote', output, `(${fs.statSync(output).size} bytes)`);

const texture = root.listTextures()[0];
if (texture) {
  const pngOut = output.replace(/\.glb$/i, '.png');
  fs.writeFileSync(pngOut, Buffer.from(texture.getImage()));
  console.log('wrote', pngOut, texture.getSize()?.join('×'));
}

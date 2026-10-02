// WebGL2 port of Assets/8-GPU_Boids_Final_Clean (GPUFlock.cs + Boid.compute + Boids.shader).
//
// Unity keeps one RWStructuredBuffer<Boid> and updates it in place from a compute kernel.
// WebGL2 has no compute shaders, so boid state lives in two ping-ponged float textures
// (one texel per boid) updated by full-screen fragment passes:
//
//   dirTex  = (direction.xyz, velocity)         <- pass 1: flocking rules (the CSMain neighbour loop)
//   posTex  = (position.xyz,  animation frame)   <- pass 2: integrate position + frame counter
//   staticTex = (noise_offset, size)             <- written once at spawn
//
// The vertex shader then reads the same textures with gl_InstanceID, exactly like
// Boids.shader reads boidBuffer[unity_InstanceID] in its procedural setup().

import * as THREE from 'three';

const TEX_WIDTH = 256;
const MAX_VELOCITY_ANIMATION_SPEED = 12; // Boid.compute

const fullscreenVert = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const header = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 outColor;
`;

// Pass 1 - CSMain up to and including the direction update.
const directionFrag = header + /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uDir;
uniform sampler2D uStatic;
uniform int uCount;
uniform int uWidth;
uniform int uStep;          // neighbour sampling stride (1 = brute force, like the original)
uniform float uDeltaTime;
uniform float uRotationSpeed;
uniform float uBoidSpeed;
uniform float uBoidSpeedVariation;
uniform float uNeighbourDistance;
uniform float uNoiseTime;
uniform vec3 uFlockPosition;

float hash(float n) { return fract(sin(n) * 43758.5453); }

// Same value noise as Boid.compute (returns 0..1)
float noise1(vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n = p.x + p.y * 57.0 + 113.0 * p.z;
  return mix(mix(mix(hash(n + 0.0), hash(n + 1.0), f.x),
                 mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y),
             mix(mix(hash(n + 113.0), hash(n + 114.0), f.x),
                 mix(hash(n + 170.0), hash(n + 171.0), f.x), f.y), f.z);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int id = coord.y * uWidth + coord.x;
  vec4 dirIn = texelFetch(uDir, coord, 0);
  if (id >= uCount) { outColor = dirIn; return; }

  vec3 boid_pos = texelFetch(uPos, coord, 0).xyz;
  float noise_offset = texelFetch(uStatic, coord, 0).x;

  // _Time / 100.0 + noise_offset, truncated to float3 by noise1(). Unity does not bind
  // _Time for compute shaders, so the original effectively ran with uNoiseTime = 0.
  vec3 t = vec3(uNoiseTime / 20.0, uNoiseTime, uNoiseTime * 2.0);
  float noise = clamp(noise1(t / 100.0 + noise_offset), -1.0, 1.0) * 2.0 - 1.0;
  float velocity = uBoidSpeed * (1.0 + noise * uBoidSpeedVariation);

  float distance_from_flock = distance(boid_pos, uFlockPosition);
  if (distance_from_flock > 50.0)
    velocity += distance_from_flock / 50.0;
  velocity += min(max(distance_from_flock / 50.0, 1.0), uBoidSpeed * 200.0);

  // When only every uStep-th boid is visited, sums are scaled by uStep and the target's
  // "self" weight (nearbyCount = 1) by 1/uStep so the averages match the brute-force loop.
  // Each boid always visits its own residue class (j = id mod uStep): the sample set is fixed
  // over time and symmetric, so it adds no frame-to-frame noise (a random per-frame subset
  // made individual birds jitter).
  float stride = float(uStep);
  float selfWeight = 1.0 / stride;
  vec3 separation = vec3(0.0);
  vec3 alignment = vec3(0.0);
  vec3 cohesion = uFlockPosition * selfWeight;
  float nearbyCount = selfWeight;

  if (uNeighbourDistance > 0.0) {
    for (int i = id % uStep; i < uCount; i += uStep) {
      if (i == id) continue;
      ivec2 c = ivec2(i % uWidth, i / uWidth);
      vec3 other = texelFetch(uPos, c, 0).xyz;
      vec3 diff = boid_pos - other;
      float diffLen = length(diff);
      if (diffLen < uNeighbourDistance) {
        float scaler = clamp(1.0 - diffLen / uNeighbourDistance, 0.0, 1.0);
        separation += diff * (scaler / max(diffLen, 1e-5));
        alignment += texelFetch(uDir, c, 0).xyz;
        cohesion += other;
        nearbyCount += 1.0;
      }
    }
  }
  separation *= stride;

  float avg = 1.0 / nearbyCount;
  alignment *= avg;
  cohesion *= avg;
  vec3 toCohesion = cohesion - boid_pos;
  cohesion = dot(toCohesion, toCohesion) > 0.0 ? normalize(toCohesion) : vec3(0.0);

  vec3 direction = alignment + separation + cohesion;

  float ip = exp(-uRotationSpeed * uDeltaTime);
  vec3 oldDir = dot(dirIn.xyz, dirIn.xyz) > 0.0 ? normalize(dirIn.xyz) : vec3(0.0, 0.0, 1.0);
  outColor = vec4(mix(direction, oldDir, ip), velocity);
}
`;

// Pass 2 - position integration and wing-flap frame counter.
const positionFrag = header + /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uDir;
uniform int uCount;
uniform int uWidth;
uniform int uFrames;
uniform float uDeltaTime;
uniform float uBoidFrameSpeed;

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int id = coord.y * uWidth + coord.x;
  vec4 posIn = texelFetch(uPos, coord, 0);
  if (id >= uCount) { outColor = posIn; return; }

  vec4 dir = texelFetch(uDir, coord, 0);
  float velocity = dir.w;
  vec3 position = posIn.xyz + dir.xyz * (velocity * uDeltaTime);

  float frame = posIn.w + min(velocity, ${MAX_VELOCITY_ANIMATION_SPEED.toFixed(1)}) * (uDeltaTime * uBoidFrameSpeed);
  if (floor(frame) >= float(uFrames)) frame = 0.0;

  outColor = vec4(position, frame);
}
`;

const copyFrag = header + /* glsl */ `
uniform sampler2D uSource;
void main() { outColor = texelFetch(uSource, ivec2(gl_FragCoord.xy), 0); }
`;

export class GPUFlock {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} opts
   * @param {number} opts.count            BoidsCount
   * @param {object} opts.sparrow          baked mesh from assets/sparrow.json
   * @param {THREE.Texture} opts.map       Sparrow.jpg
   */
  constructor(renderer, { count, sparrow, map, params = GPUFlock.defaultParams() }) {
    this.renderer = renderer;
    this.count = count;
    this.width = TEX_WIDTH;
    this.height = Math.ceil(count / TEX_WIDTH);
    this.frames = sparrow.frames;
    this.frameIndex = 0;
    this.samplesPerBoid = 0; // 0 = check every boid (exact port)
    this.params = params;

    const floatOk = renderer.extensions.has('EXT_color_buffer_float');
    this.texType = floatOk ? THREE.FloatType : THREE.HalfFloatType;
    if (!floatOk) console.warn('EXT_color_buffer_float missing: falling back to half floats (reduced precision)');

    const rt = () => new THREE.WebGLRenderTarget(this.width, this.height, {
      type: this.texType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.posRT = [rt(), rt()];
    this.dirRT = [rt(), rt()];
    this.current = 0;

    this.staticTex = new THREE.DataTexture(
      new Float32Array(this.width * this.height * 4), this.width, this.height,
      THREE.RGBAFormat, THREE.FloatType);
    this.staticTex.minFilter = this.staticTex.magFilter = THREE.NearestFilter;

    // --- compute passes ---
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    const pass = (fragmentShader, uniforms) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: fullscreenVert, fragmentShader, uniforms,
      depthTest: false, depthWrite: false,
    });
    this.directionPass = pass(directionFrag, {
      uPos: { value: null }, uDir: { value: null }, uStatic: { value: this.staticTex },
      uCount: { value: count }, uWidth: { value: this.width }, uStep: { value: 1 },
      uDeltaTime: { value: 0 }, uRotationSpeed: { value: 0 }, uBoidSpeed: { value: 0 },
      uBoidSpeedVariation: { value: 0 }, uNeighbourDistance: { value: 0 }, uNoiseTime: { value: 0 },
      uFlockPosition: { value: new THREE.Vector3() },
    });
    this.positionPass = pass(positionFrag, {
      uPos: { value: null }, uDir: { value: null },
      uCount: { value: count }, uWidth: { value: this.width }, uFrames: { value: this.frames },
      uDeltaTime: { value: 0 }, uBoidFrameSpeed: { value: 0 },
    });
    this.copyPass = pass(copyFrag, { uSource: { value: null } });

    this.mesh = this.createMesh(sparrow, map);
  }

  /** GPUFlock inspector values from AllFlocks.unity */
  static defaultParams() {
    return {
      RotationSpeed: 4,
      BoidSpeed: 6,
      NeighbourDistance: 0,
      BoidSpeedVariation: 0,
      BoidFrameSpeed: 10,
      SpawnRadius: 200,
    };
  }

  /** CreateBoidData() for every boid, around `center`. */
  reset(center) {
    const n = this.width * this.height;
    const pos = new Float32Array(n * 4);
    const dir = new Float32Array(n * 4);
    const stat = this.staticTex.image.data;
    const v = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const identity = new THREE.Quaternion();
    const toDeg = 180 / Math.PI;
    for (let i = 0; i < this.count; i++) {
      // Random.insideUnitSphere * SpawnRadius
      do v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      while (v.lengthSq() > 1);
      v.multiplyScalar(this.params.SpawnRadius).add(center);
      pos.set([v.x, v.y, v.z, 0], i * 4);

      // direction = Quaternion.Slerp(rotation, Random.rotation, 0.3).eulerAngles
      // (a vector of degrees; only its normalized value survives the first step)
      q.random();
      q.copy(identity).slerp(q, 0.3);
      e.setFromQuaternion(q, 'YXZ');
      const deg = (a) => ((a * toDeg) % 360 + 360) % 360;
      dir.set([deg(e.x), deg(e.y), -deg(e.z), 0], i * 4);

      stat.set([Math.random() * 1000, 0.5 + Math.random()], i * 4); // noise_offset, size
    }
    this.staticTex.needsUpdate = true;

    this.current = 0;
    this.upload(pos, this.posRT[0]);
    this.upload(dir, this.dirRT[0]);
    this.bindRenderTextures();
  }

  upload(data, target) {
    const tex = new THREE.DataTexture(data, this.width, this.height, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    this.copyPass.uniforms.uSource.value = tex;
    this.runPass(this.copyPass, target);
    tex.dispose();
  }

  runPass(material, target) {
    const r = this.renderer;
    // While presenting, WebGLRenderer.render() swaps in the XR camera; GPGPU passes
    // must bypass that, then hand the XR framebuffer back.
    const xrEnabled = r.xr.enabled;
    const prevTarget = r.getRenderTarget();
    r.xr.enabled = false;
    this.quad.material = material;
    r.setRenderTarget(target);
    r.render(this.quadScene, this.quadCamera);
    r.setRenderTarget(prevTarget);
    r.xr.enabled = xrEnabled;
  }

  /** GPUFlock.Update(): SetComputeData() + Dispatch(). */
  step(dt, flockPosition, noiseTime = 0) {
    const p = this.params;
    const cur = this.current;
    const nxt = 1 - cur;
    const stride = this.samplesPerBoid > 0
      ? Math.max(1, Math.ceil(this.count / this.samplesPerBoid)) : 1;

    const du = this.directionPass.uniforms;
    du.uPos.value = this.posRT[cur].texture;
    du.uDir.value = this.dirRT[cur].texture;
    du.uStep.value = stride;
    this.frameIndex++;
    du.uDeltaTime.value = dt;
    du.uRotationSpeed.value = p.RotationSpeed;
    du.uBoidSpeed.value = p.BoidSpeed;
    du.uBoidSpeedVariation.value = p.BoidSpeedVariation;
    du.uNeighbourDistance.value = p.NeighbourDistance;
    du.uNoiseTime.value = noiseTime;
    du.uFlockPosition.value.copy(flockPosition);
    this.runPass(this.directionPass, this.dirRT[nxt]);

    const pu = this.positionPass.uniforms;
    pu.uPos.value = this.posRT[cur].texture;
    pu.uDir.value = this.dirRT[nxt].texture;
    pu.uDeltaTime.value = dt;
    pu.uBoidFrameSpeed.value = p.BoidFrameSpeed;
    this.runPass(this.positionPass, this.posRT[nxt]);

    this.current = nxt;
    this.bindRenderTextures();
  }

  bindRenderTextures() {
    this.renderUniforms.uPos.value = this.posRT[this.current].texture;
    this.renderUniforms.uDir.value = this.dirRT[this.current].texture;
  }

  /** Graphics.DrawMeshInstancedIndirect(BoidMesh, ...) with the vertex-animation lookup of Boids.shader. */
  createMesh(sparrow, map) {
    const V = sparrow.vertexCount;
    const F = sparrow.frames;

    // Rows [0, F): positions per frame, rows [F, 2F): normals per frame. One texel per vertex.
    const anim = new Float32Array(V * F * 2 * 4);
    for (let f = 0; f < F; f++) {
      for (let v = 0; v < V; v++) {
        const s = (f * V + v) * 3;
        anim.set([sparrow.positions[s], sparrow.positions[s + 1], sparrow.positions[s + 2], 1], (f * V + v) * 4);
        anim.set([sparrow.normals[s], sparrow.normals[s + 1], sparrow.normals[s + 2], 0], ((F + f) * V + v) * 4);
      }
    }
    const animTex = new THREE.DataTexture(anim, V, F * 2, THREE.RGBAFormat, THREE.FloatType);
    animTex.minFilter = animTex.magFilter = THREE.NearestFilter;
    animTex.needsUpdate = true;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(sparrow.index);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(sparrow.positions.slice(0, V * 3), 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(sparrow.normals.slice(0, V * 3), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(sparrow.uv, 2));
    geo.setAttribute('vid', new THREE.Float32BufferAttribute(Float32Array.from({ length: V }, (_, i) => i), 1));
    geo.instanceCount = this.count;

    // SparrowInstanced.mat: _Color 0.816 grey, smoothness 0.1, metallic 0, Sparrow.JPG
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.8161765, 0.8161765, 0.8161765, THREE.SRGBColorSpace),
      map,
      roughness: 0.9,
      metalness: 0,
    });

    this.renderUniforms = {
      uPos: { value: null },
      uDir: { value: null },
      uStatic: { value: this.staticTex },
      uAnim: { value: animTex },
      uTexWidth: { value: this.width },
      uFrames: { value: F },
    };

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.renderUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `#include <common>
uniform highp sampler2D uPos;
uniform highp sampler2D uDir;
uniform highp sampler2D uStatic;
uniform highp sampler2D uAnim;
uniform int uTexWidth;
uniform int uFrames;
attribute float vid;
`)
        .replace('#include <beginnormal_vertex>', /* glsl */ `
  // setup(): fetch this instance's boid
  ivec2 boidCoord = ivec2(gl_InstanceID % uTexWidth, gl_InstanceID / uTexWidth);
  vec4 boidPosFrame = texelFetch(uPos, boidCoord, 0);
  vec3 boidDir = texelFetch(uDir, boidCoord, 0).xyz;
  float boidSize = texelFetch(uStatic, boidCoord, 0).y;

  // look_at_matrix(position, position - direction, up): model +Z (the beak) follows direction
  vec3 zAxis = dot(boidDir, boidDir) > 0.0 ? normalize(boidDir) : vec3(0.0, 0.0, 1.0);
  vec3 xAxis = cross(vec3(0.0, 1.0, 0.0), zAxis);
  xAxis = dot(xAxis, xAxis) > 1e-10 ? normalize(xAxis) : vec3(1.0, 0.0, 0.0);
  mat3 boidBasis = mat3(xAxis, cross(zAxis, xAxis), zAxis);

  // FRAME_INTERPOLATION between baked vertex-animation frames
  float frameFloor = floor(boidPosFrame.w);
  int currentFrame = min(int(frameFloor), uFrames - 1);
  int nextFrame = currentFrame + 1 >= uFrames ? 0 : currentFrame + 1;
  float frameInterpolation = boidPosFrame.w - frameFloor;
  int vertexId = int(vid);

  vec3 objectNormal = boidBasis * normalize(mix(
    texelFetch(uAnim, ivec2(vertexId, uFrames + currentFrame), 0).xyz,
    texelFetch(uAnim, ivec2(vertexId, uFrames + nextFrame), 0).xyz,
    frameInterpolation));
`)
        .replace('#include <begin_vertex>', /* glsl */ `
  vec3 transformed = mix(
    texelFetch(uAnim, ivec2(vertexId, currentFrame), 0).xyz,
    texelFetch(uAnim, ivec2(vertexId, nextFrame), 0).xyz,
    frameInterpolation);
  transformed = boidBasis * (transformed * boidSize) + boidPosFrame.xyz;
`);
    };

    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false; // InfiniteBounds
    return mesh;
  }

  dispose() {
    for (const t of [...this.posRT, ...this.dirRT]) t.dispose();
    this.staticTex.dispose();
    this.renderUniforms.uAnim.value.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const m of [this.directionPass, this.positionPass, this.copyPass]) m.dispose();
  }
}

# AndyBirds – WebXR

A browser/WebXR port of the Unity scene `Assets/AllFlocks.unity`. A 28 000-bird GPU flock chases the point you look at, and its parameters are choreographed to the music. It uses three.js with WebGL2 GPGPU and has no build step.

## Run

Serve this folder over HTTP (any static server that supports Range requests, so the music can seek):

```sh
npx serve .            # or: python -m http.server 8000
```

Open the page and press **Start on desktop** or **Enter VR**. Both buttons also start the music.

WebXR needs a secure context. `localhost` counts as secure, so the simplest way to test on a Quest over USB is:

```sh
adb reverse tcp:3000 tcp:3000   # then open http://localhost:3000 in the Quest browser
```

Otherwise serve it over HTTPS.

### URL parameters

| Param | Default | Meaning |
| --- | --- | --- |
| `boids` | 28000 desktop, 8192 standalone headset | `BoidsCount` |
| `model` | `sparrow` | Species mesh: `sparrow` or `bat` |
| `samples` | 2048 desktop, 256 standalone | Neighbours checked per boid per frame. `0` = all of them, the exact O(N²) loop of the original |
| `gazeSocket` | – | WebSocket URL of an eye-tracker bridge, e.g. `ws://localhost:8887` |
| `reticle` | off | `1` shows the flock target (the Unity sphere renderer was disabled) |
| `choreography` | on | `0` disables the Metronome so you can drive the params from the panel |

On desktop, drag to look around. The **GPU Flock** panel exposes the inspector values, and *Gaze → mouse = eye tracker* lets the cursor stand in for gaze.

## How the Unity project maps across

| Unity | Web |
| --- | --- |
| `GPUFlock.cs` + `Boid.compute`: one `RWStructuredBuffer<Boid>` updated in place by a compute kernel | `src/flock.js`: boid state in ping-ponged float textures (one texel per boid), updated by two full-screen fragment passes: flocking rules → direction/velocity, then integration → position/anim-frame |
| `Boids.shader`: procedural instancing, `look_at_matrix`, vertex-animation lookup with `FRAME_INTERPOLATION` | Same logic injected into `MeshStandardMaterial` via `onBeforeCompile`, indexed with `gl_InstanceID`. One instanced draw call |
| `GenerateSkinnedAnimationForGPUBuffer()`: bakes the skinned sparrow into `NbFrames` vertex frames at startup | `tools/bake-sparrow.mjs` does the same bake offline into `assets/sparrow.json` (16 frames, like Unity's `ClosestPowerOfTwo(19)`). The FBX is version 6.0, which three.js cannot load. |
| `GazeControlled.cs`: `Physics.Raycast(HmdOrigin, GazeDirectionCombined)` against two invisible `InsideOutHemisphere` mesh colliders | `src/gaze.js` provides the ray. `intersectDome()` is an analytic ray/inward-facing-hemisphere test (r = 48.24 m, centre (140, 0, 0)). With no hit, the target rides along with the flock root, as the child transform did |
| `Metronome.cs`: 128 BPM bar counter on the audio DSP clock driving `NeighbourDistance`, `BoidSpeed`, `BoidSpeedVariation` | `src/choreography.js`: the same bar script, clocked from `audio.currentTime` (1.21 s offset kept) |
| `BringFlockForward.cs` | `flockRoot.lerp(...)` in `main.js` |
| `SH Skybox.shader` + *Walk Of Fame skybox* material | `src/sky.js`, the same SH9 evaluation and coefficients |
| Scene: camera (133.5, 6.5, 8.8) facing −X at 45° FOV, linear fog 15–80, flat black ambient, one directional light | Same values. Unity's left-handed coordinates are converted by negating Z. In VR the starting head pose is placed at the Unity camera via an offset `local` reference space |

## Gaze sources

The sources below are tried in priority order. The HUD shows which one is active.

1. **Eye-tracker bridge** (`?gazeSocket=`). Send JSON messages at any rate; a sample is used for 250 ms:
   ```jsonc
   {"dir": [x, y, z]}                         // head-local gaze direction, WebXR axes (-Z forward)
   {"dir": [x, y, z], "convention": "unity"}  // Unity / Tobii XR axes (+Z forward, left-handed)
   {"dir": [...], "origin": [x, y, z]}         // optional head-local ray origin in metres
   {"screen": [u, v]}                         // desktop screen trackers: normalised, (0,0) = top-left
   {"valid": false}                           // tracking lost -> falls back immediately
   ```
   This is how you connect a Tobii tracker: a small native app reads the gaze from the Tobii SDK/OpenXR `XR_EXT_eye_gaze_interaction` and forwards it.
2. **WebXR eye-driven input**: input sources with `targetRayMode` of `'gaze'` or `'transient-pointer'` (for example Vision Pro while pinching). There is no standard always-on WebXR eye-tracking API, so most headsets will fall through to the next source.
3. **Mouse** (desktop, opt-in from the panel).
4. **Nose pointer**: head forward in VR, view centre on desktop.

## Deliberate differences from the Unity build

- **Neighbour sampling.** The original checks every boid against every other (784 M checks per frame at 28k). By default each boid only checks the boids in its own residue class (`j ≡ i mod k`), with the sums rescaled to match the full loop on average. In effect the flock is k interleaved sub-flocks chasing the same target. The sample set is fixed and symmetric, so it adds no frame-to-frame noise. A randomly rotating subset made individual birds visibly jitter, with up to 72° heading kicks per frame. Use `?samples=0` for the exact loop; it held vsync on an RTX 4080 laptop GPU at 28k boids.
- **Normals** are rotated with each bird and recomputed per animation frame. `Boids.shader` left the static mesh normals in object space, so every bird was shaded as if facing the same way.
- **Wing-flap bake** samples the whole clip. `GenerateSkinnedAnimationForGPUBuffer` passes seconds to `Animator.Play`'s *normalised* time parameter, so Unity probably baked only ~75 % of the flap cycle.
- **Speed noise** is static per bird (`uNoiseTime = 0`). Unity doesn't bind `_Time` for compute shaders, so the original also ran this way; pass a time to `flock.step()` to animate it.
- **Not ported because they're disabled in `AllFlocks.unity`:** drawing affectors (`UseAffectors: 0`), the `BrownianMotion` on the target, and the CPU/early GPU variants in folders 1–7.

## Rebuilding the bird mesh

```sh
cd tools
npm install
npm run bake        # FBX -> glTF (FBX2glTF) -> sample 16 frames -> ../assets/sparrow.json
npm run bake:bat    # bat-fixed.glb wing_flap -> ../assets/bat.json (+ bat.png)
```

`bake:bat` reads `c:/Users/araf/Downloads/bat-fixed.glb` by default (override with `BAT_GLB=...`). Switch species at runtime with `?model=bat` or the **Species** control in the GPU Flock panel.

`assets/music.mp3` is copied from `Assets/` and is a commercial track. Remove or replace it before hosting the page publicly; without it the choreography runs on a silent clock.

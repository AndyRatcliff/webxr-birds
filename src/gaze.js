// Replacement for TobiiVR.HmdOrigin / TobiiVR.GazeDirectionCombined.
//
// Sources, highest priority first:
//   1. bridge  - eye tracker streamed over a WebSocket (?gazeSocket=ws://host:port), see README
//   2. xr-eye  - a WebXR input source whose target ray is driven by the eyes
//                ('gaze' or 'transient-pointer', e.g. Apple Vision Pro while pinching)
//   3. mouse   - desktop only, opt-in: the cursor stands in for an eye tracker
//   4. nose    - head/camera forward (always available)

import * as THREE from 'three';

const BRIDGE_TIMEOUT_MS = 250;
const FORWARD = new THREE.Vector3(0, 0, -1);

export class GazeTracker {
  constructor({ socketUrl = null } = {}) {
    this.ray = new THREE.Ray();
    this.source = 'nose';
    this.useMouse = false;
    this.mouseNdc = null;

    this.bridge = { url: socketUrl, status: socketUrl ? 'connecting' : 'off', sample: null, time: 0 };
    if (socketUrl) this.connect(socketUrl);

    this.headPosition = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._srcQuat = new THREE.Quaternion();
  }

  connect(url) {
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      this.bridge.status = 'error';
      return;
    }
    socket.onopen = () => { this.bridge.status = 'open'; };
    socket.onclose = () => {
      this.bridge.status = 'closed';
      setTimeout(() => this.connect(url), 2000);
    };
    socket.onerror = () => { this.bridge.status = 'error'; };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.valid === false) { this.bridge.sample = null; return; }
      const dir = msg.dir ?? msg.direction ?? msg.gaze_direction;
      if (dir) {
        // Head-local direction. Default is the WebXR/OpenXR convention (+X right, +Y up, -Z forward);
        // "convention":"unity" takes Unity/Tobii XR axes (+Z forward, left-handed).
        const z = msg.convention === 'unity' ? -dir[2] : dir[2];
        this.bridge.sample = {
          dir: new THREE.Vector3(dir[0], dir[1], z).normalize(),
          origin: msg.origin ? new THREE.Vector3(msg.origin[0], msg.origin[1],
            msg.convention === 'unity' ? -msg.origin[2] : msg.origin[2]) : null,
        };
      } else if (msg.screen) {
        // Normalised screen point, (0,0) top-left: screen-based (desktop) eye trackers.
        this.bridge.sample = { screen: { x: msg.screen[0], y: msg.screen[1] } };
      } else {
        return;
      }
      this.bridge.time = performance.now();
    };
  }

  /**
   * @param {object} ctx
   * @param {THREE.Camera} ctx.camera        desktop camera (also the XR camera's parent pose source)
   * @param {XRFrame} [ctx.xrFrame]
   * @param {XRReferenceSpace} [ctx.refSpace] world-aligned reference space
   */
  update({ camera, xrFrame = null, refSpace = null }) {
    // Head pose: XR viewer pose or the desktop camera.
    const headPos = this.headPosition;
    const headQuat = this._quat;
    let viewerPose = null;
    if (xrFrame && refSpace) viewerPose = xrFrame.getViewerPose(refSpace);
    if (viewerPose) {
      const t = viewerPose.transform;
      headPos.set(t.position.x, t.position.y, t.position.z);
      headQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
    } else {
      camera.getWorldPosition(headPos);
      camera.getWorldQuaternion(headQuat);
    }

    // 1. External eye tracker
    const b = this.bridge.sample;
    if (b && performance.now() - this.bridge.time < BRIDGE_TIMEOUT_MS) {
      if (b.dir) {
        this.ray.origin.copy(b.origin ?? new THREE.Vector3()).applyQuaternion(headQuat).add(headPos);
        this.ray.direction.copy(b.dir).applyQuaternion(headQuat);
        this.source = 'eye (bridge)';
        return this.ray;
      }
      if (b.screen && !viewerPose) {
        this.rayFromNdc(camera, b.screen.x * 2 - 1, 1 - b.screen.y * 2);
        this.source = 'eye (bridge, screen)';
        return this.ray;
      }
    }

    // 2. WebXR eye-driven input source
    if (xrFrame && refSpace) {
      for (const src of xrFrame.session.inputSources) {
        if (src.targetRayMode !== 'gaze' && src.targetRayMode !== 'transient-pointer') continue;
        const pose = xrFrame.getPose(src.targetRaySpace, refSpace);
        if (!pose) continue;
        const t = pose.transform;
        this.ray.origin.set(t.position.x, t.position.y, t.position.z);
        this._srcQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
        this.ray.direction.copy(FORWARD).applyQuaternion(this._srcQuat);
        this.source = `eye (webxr ${src.targetRayMode})`;
        return this.ray;
      }
    }

    // 3. Desktop mouse as simulated eye tracker
    if (!viewerPose && this.useMouse && this.mouseNdc) {
      this.rayFromNdc(camera, this.mouseNdc.x, this.mouseNdc.y);
      this.source = 'mouse';
      return this.ray;
    }

    // 4. Nose pointer
    this.ray.origin.copy(headPos);
    this.ray.direction.copy(FORWARD).applyQuaternion(headQuat);
    this.source = 'nose';
    return this.ray;
  }

  rayFromNdc(camera, x, y) {
    camera.getWorldPosition(this.ray.origin);
    this.ray.direction.set(x, y, 0.5).unproject(camera).sub(this.ray.origin).normalize();
  }
}

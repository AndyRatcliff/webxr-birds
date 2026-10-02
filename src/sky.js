// Port of Assets/Common/SH Skybox.shader with the "Walk Of Fame skybox" material values.
// The sky is an L2 spherical-harmonics gradient (no texture), unaffected by fog.

import * as THREE from 'three';

const WALK_OF_FAME = {
  SHAr: [0.312602133, 0.0481133349, -0.0658104345, 0.641293108],
  SHAg: [0.286417633, 0.173308149, -0.0618516393, 0.596976995],
  SHAb: [0.237915561, 0.397836357, -0.0621705018, 0.641477406],
  SHBr: [-0.141452298, 0.00759834098, -0.317703187, -0.129272699],
  SHBg: [-0.0672449693, -0.0016070907, -0.278647214, -0.129255682],
  SHBb: [0.0055519212, -0.0128071541, -0.274035752, -0.129693493],
  SHC: [0.253520846, 0.172574505, 0.0737705827],
};

export function createSky(radius = 900) {
  const uniforms = { uIntensity: { value: 1 } };
  for (const [k, v] of Object.entries(WALK_OF_FAME)) {
    uniforms['u' + k] = { value: v.length === 4 ? new THREE.Vector4(...v) : new THREE.Vector3(...v) };
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      uniform vec4 uSHAr, uSHAg, uSHAb, uSHBr, uSHBg, uSHBb;
      uniform vec3 uSHC;
      varying vec3 vDir;

      vec3 shadeSH9(vec4 n) {
        vec3 x1 = vec3(dot(uSHAr, n), dot(uSHAg, n), dot(uSHAb, n));
        vec4 vB = n.yzzx * n.xyzz;
        vec3 x2 = vec3(dot(uSHBr, vB), dot(uSHBg, vB), dot(uSHBb, vB));
        vec3 x3 = uSHC * (n.x * n.x - n.y * n.y);
        return x1 + x2 + x3;
      }

      void main() {
        vec3 d = normalize(vDir);
        // Coefficients are in Unity's left-handed space: flip Z.
        gl_FragColor = vec4(max(shadeSH9(vec4(d.x, d.y, -d.z, 1.0)), 0.0) * uIntensity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  return sky;
}

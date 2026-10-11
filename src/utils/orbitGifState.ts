import * as THREE from 'three';

/** Attempt every cleanup even if a disposed context or event listener throws. */
export function runOrbitCleanup(actions: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}

export function captureOrbitRenderState(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
) {
  return {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(),
    mip: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    background: scene.background,
    overrideMaterial: scene.overrideMaterial,
    outputColorSpace: renderer.outputColorSpace,
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    xrEnabled: renderer.xr.enabled,
  };
}

export function restoreOrbitRenderState(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  state: ReturnType<typeof captureOrbitRenderState>,
): void {
  runOrbitCleanup([
    () => {
      scene.background = state.background;
      scene.overrideMaterial = state.overrideMaterial;
    },
    () => {
      renderer.outputColorSpace = state.outputColorSpace;
    },
    () => {
      renderer.toneMapping = state.toneMapping;
      renderer.toneMappingExposure = state.exposure;
      renderer.xr.enabled = state.xrEnabled;
    },
    () => {
      renderer.setClearColor(state.clearColor, state.clearAlpha);
    },
    // Restore logical defaults before binding the old target: setRenderTarget
    // applies its own physical viewport/scissor, independent of pixel ratio.
    () => {
      renderer.setViewport(state.viewport);
    },
    () => {
      renderer.setScissor(state.scissor);
    },
    () => {
      renderer.setScissorTest(state.scissorTest);
    },
    () => {
      renderer.setRenderTarget(state.target, state.face, state.mip);
    },
  ]);
}

type Controls = { enabled: boolean; target: THREE.Vector3 };

export function captureOrbitViewState(
  object: THREE.Object3D,
  camera: THREE.Camera,
  controls?: Controls,
) {
  return {
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
    matrix: object.matrix.clone(),
    matrixAutoUpdate: object.matrixAutoUpdate,
    camera: camera.clone(false),
    controlsEnabled: controls?.enabled,
    controlsTarget: controls?.target.clone(),
  };
}

export function restoreOrbitViewState(
  object: THREE.Object3D,
  camera: THREE.Camera,
  controls: Controls | undefined,
  state: ReturnType<typeof captureOrbitViewState>,
): void {
  runOrbitCleanup([
    () => {
      object.position.copy(state.position);
      object.quaternion.copy(state.quaternion);
      object.scale.copy(state.scale);
      object.matrix.copy(state.matrix);
      object.matrixAutoUpdate = state.matrixAutoUpdate;
      object.updateWorldMatrix(true, true);
    },
    // copy(false) preserves the original camera identity, parent and children,
    // and restores both camera families' projection parameters and matrices.
    () => {
      camera.copy(state.camera, false);
      camera.updateWorldMatrix(true, false);
    },
    () => {
      if (
        controls &&
        state.controlsTarget &&
        state.controlsEnabled !== undefined
      ) {
        controls.target.copy(state.controlsTarget);
        controls.enabled = state.controlsEnabled;
      }
    },
  ]);
}

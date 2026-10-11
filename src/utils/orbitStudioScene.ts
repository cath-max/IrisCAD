import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

/** Smooth, bounded studio illumination without the bright points of a city HDR. */
function studioEnvironment(): THREE.DataTexture {
  const width = 128,
    height = 64;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const elevation = Math.PI * ((y + 0.5) / height - 0.5);
    for (let x = 0; x < width; x++) {
      const azimuth = (2 * Math.PI * (x + 0.5)) / width;
      const brightness =
        0.3 +
        0.25 * (Math.sin(elevation) + 1) +
        0.25 *
          Math.pow(Math.cos(elevation), 2) *
          (0.5 + 0.5 * Math.cos(azimuth));
      const i = (y * width + x) * 4;
      data.set([brightness, brightness, brightness, 1], i);
    }
  }
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Shares geometry, owns cloned materials/lights/textures. Never moves the preview. */
export function createOrbitStudio(
  source: THREE.Object3D,
  bounds: THREE.Box3,
  previewScene?: THREE.Scene,
) {
  RectAreaLightUniformsLib.init();
  source.updateWorldMatrix(true, true);
  const scene = new THREE.Scene();
  const object = source.clone(true);
  object.matrixAutoUpdate = false;
  object.matrix.copy(source.matrixWorld);
  const materials = new Set<THREE.Material>();
  object.traverse((node) => {
    if (node instanceof THREE.Light) node.visible = false;
    if (!(node instanceof THREE.Mesh)) return;
    const copy = (material: THREE.Material) => {
      const cloned = material.clone();
      materials.add(cloned);
      if (!previewScene && cloned instanceof THREE.MeshStandardMaterial) {
        // Use the export environment, including for models with an explicit map.
        cloned.envMap = null;
      }
      return cloned;
    };
    node.material = Array.isArray(node.material)
      ? node.material.map(copy)
      : copy(node.material);
  });
  // Visibility inherited from ancestors is otherwise lost when detaching a clone.
  for (let ancestor = source.parent; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible) object.visible = false;
  }
  scene.add(object);
  const environment = previewScene ? null : studioEnvironment();
  scene.environment = previewScene?.environment ?? environment;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 1);
  const area = (position: [number, number, number], intensity: number) => {
    const light = new THREE.RectAreaLight(
      0xffffff,
      intensity,
      extent * 2.5,
      extent * 2.5,
    );
    light.position
      .set(...position)
      .multiplyScalar(extent)
      .add(center);
    light.lookAt(center);
    scene.add(light);
  };
  if (previewScene) {
    previewScene.updateMatrixWorld(true);
    previewScene.traverseVisible((node) => {
      if (!(node instanceof THREE.Light)) return;
      const light = node.clone();
      node.matrixWorld.decompose(light.position, light.quaternion, light.scale);
      if (
        light instanceof THREE.DirectionalLight ||
        light instanceof THREE.SpotLight
      ) {
        const original = node as THREE.DirectionalLight | THREE.SpotLight;
        light.target = new THREE.Object3D();
        original.target.getWorldPosition(light.target.position);
        light.castShadow = false;
        scene.add(light.target);
      }
      scene.add(light);
    });
  } else {
    area([1.5, 2, 1.5], 1.0);
    area([-1.5, 1, -1.5], 0.5);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x737780, 0.8));
  }

  // A static soft grounding shadow, independent of camera/frame callbacks.
  const shadowSize = 64;
  const pixels = new Uint8Array(shadowSize * shadowSize * 4);
  for (let y = 0; y < shadowSize; y++) {
    for (let x = 0; x < shadowSize; x++) {
      const r2 =
        (((x + 0.5) / shadowSize) * 2 - 1) ** 2 +
        (((y + 0.5) / shadowSize) * 2 - 1) ** 2;
      pixels[(y * shadowSize + x) * 4 + 3] = Math.round(
        65 * Math.max(0, 1 - r2) ** 2,
      );
    }
  }
  const shadowTexture = new THREE.DataTexture(pixels, shadowSize, shadowSize);
  shadowTexture.magFilter = THREE.LinearFilter;
  shadowTexture.needsUpdate = true;
  const shadowGeometry = new THREE.PlaneGeometry(
    Math.max(size.x, 1) * 1.5,
    Math.max(size.z, 1) * 1.5,
  );
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(center.x, bounds.min.y - extent * 0.001, center.z);
  scene.add(shadow);
  scene.updateMatrixWorld(true);
  let disposed = false;
  return {
    scene,
    object,
    dispose() {
      if (disposed) return;
      disposed = true;
      materials.forEach((material) => material.dispose());
      environment?.dispose();
      shadowTexture.dispose();
      shadowGeometry.dispose();
      shadowMaterial.dispose();
      scene.clear();
    },
  };
}

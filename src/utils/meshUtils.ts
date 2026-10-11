import * as THREE from 'three';
import { CAD_PREVIEW_MATERIAL } from './previewMaterial.ts';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export interface BoundingBox {
  x: number;
  y: number;
  z: number;
}

/**
 * Parse an STL file and extract geometry with bounding box
 */
export async function parseSTL(
  file: File,
): Promise<{ geometry: THREE.BufferGeometry; boundingBox: BoundingBox }> {
  const buffer = await file.arrayBuffer();
  const loader = new STLLoader();
  const geometry = loader.parse(buffer);

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;

  const boundingBox: BoundingBox = {
    x: Math.round((box.max.x - box.min.x) * 100) / 100,
    y: Math.round((box.max.y - box.min.y) * 100) / 100,
    z: Math.round((box.max.z - box.min.z) * 100) / 100,
  };

  geometry.center();
  geometry.computeVertexNormals();

  return { geometry, boundingBox };
}

/**
 * Render a geometry from multiple camera angles for AI analysis
 */
export async function renderMultipleAngles(
  geometry: THREE.BufferGeometry,
  boundingBox: BoundingBox,
): Promise<Blob[]> {
  const cameraAngles = [
    { position: [1, 1, 1], name: 'isometric' },
    { position: [0, 0, 1], name: 'top' },
    { position: [0, -1, 0], name: 'front' },
    { position: [1, 0, 0], name: 'right' },
  ];

  const renders: Blob[] = [];
  const size = 512;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });

  renderer.setSize(size, size);
  renderer.setPixelRatio(1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);

  const geometryClone = geometry.clone();

  const material = new THREE.MeshStandardMaterial({
    color: 0x00a6ff,
    metalness: 0.3,
    roughness: 0.5,
  });
  const mesh = new THREE.Mesh(geometryClone, material);

  mesh.rotation.set(-Math.PI / 2, 0, 0);
  scene.add(mesh);

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight1.position.set(5, 5, 5);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.2);
  dirLight2.position.set(-5, 5, 5);
  scene.add(dirLight2);

  const dirLight3 = new THREE.DirectionalLight(0xffffff, 0.2);
  dirLight3.position.set(-5, 5, -5);
  scene.add(dirLight3);

  const maxDim = Math.max(boundingBox.x, boundingBox.y, boundingBox.z);
  const safeDim = maxDim > 0 ? maxDim : 1;
  const cameraDistance = safeDim * 2.5;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, safeDim * 10);

  try {
    for (const angle of cameraAngles) {
      camera.position.set(
        angle.position[0] * cameraDistance,
        angle.position[1] * cameraDistance,
        angle.position[2] * cameraDistance,
      );
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) {
              resolve(b);
            } else {
              reject(new Error('Failed to create blob from canvas'));
            }
          },
          'image/png',
          0.9,
        );
      });
      renders.push(blob);
    }
  } finally {
    renderer.dispose();
    geometryClone.dispose();
    material.dispose();
  }

  return renders;
}

function createPreviewRenderer(size: number) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(size, size);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setPixelRatio(window.devicePixelRatio);
  return renderer;
}

function frameScene(scene: THREE.Scene) {
  const box = new THREE.Box3().setFromObject(scene);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  // Use the bounding-box diagonal both as the ortho half-extent (with light
  // padding) and as the camera's stand-off distance from `center`. Ortho has
  // no foreshortening, so distance only needs to keep the model inside the
  // near/far planes.
  const diagonal =
    Math.sqrt(size.x * size.x + size.y * size.y + size.z * size.z) || 1;
  const halfExtent = (diagonal / 2) * 1.1;
  return { center, diagonal, halfExtent };
}

function createPreviewCamera(halfExtent: number, diagonal: number) {
  // Orthographic gives the clean technical-drawing look you want for previews:
  // parallel edges stay parallel, scale comparison reads correctly across
  // different artifacts.
  return new THREE.OrthographicCamera(
    -halfExtent,
    halfExtent,
    halfExtent,
    -halfExtent,
    0.1,
    diagonal * 10,
  );
}

function createPreviewScene(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const renderScene = new THREE.Scene();
  renderScene.background = new THREE.Color(0x3b3b3b);
  renderScene.environment = pmremGenerator.fromScene(
    new RoomEnvironment(),
    0.04,
  ).texture;

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(1, 1, 1);
  renderScene.add(directionalLight);

  renderScene.add(scene);
  return { renderScene, pmremGenerator };
}

function renderView({
  camera,
  center,
  diagonal,
  direction,
}: {
  camera: THREE.OrthographicCamera;
  center: THREE.Vector3;
  diagonal: number;
  direction: THREE.Vector3;
}) {
  camera.position.copy(center).add(
    direction
      .clone()
      .normalize()
      .multiplyScalar(diagonal * 2),
  );
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Render any prebuilt THREE.Scene to a 1000×1000 PNG data URL using the same
// camera framing (top-right-front isometric), HDR environment, and lighting
// used by generated mesh thumbnails.
function renderSceneToDataUrl(scene: THREE.Scene): string {
  const { center, diagonal, halfExtent } = frameScene(scene);
  const renderer = createPreviewRenderer(1000);
  const camera = createPreviewCamera(halfExtent, diagonal);
  const { renderScene, pmremGenerator } = createPreviewScene(renderer, scene);

  // Top-right-front isometric framing — matches the live viewer's gizmo TFR
  // corner instead of staring straight down +Z.
  renderView({
    camera,
    center,
    diagonal,
    direction: new THREE.Vector3(1, 1, 1),
  });

  renderer.render(renderScene, camera);
  const image = renderer.domElement.toDataURL('image/png');

  pmremGenerator.dispose();
  renderer.dispose();
  return image;
}

export const generatePreview = async (mesh: Blob) => {
  const arrayBuffer = await mesh.arrayBuffer();
  const loader = new STLLoader();
  const geometry = loader.parse(arrayBuffer);

  // STL input is Z-up; rotate it to the viewer's Y-up coordinate system.
  geometry.rotateX(-Math.PI / 2);
  geometry.center();
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x00a6ff,
    ...CAD_PREVIEW_MATERIAL,
  });
  const previewMesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene();
  scene.add(previewMesh);

  return renderSceneToDataUrl(scene);
};

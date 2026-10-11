import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  captureOrbitRenderState,
  captureOrbitViewState,
  restoreOrbitRenderState,
  restoreOrbitViewState,
} from './orbitGifState.ts';
import * as THREE from 'three';
import {
  computeOrbitFraming,
  flipRgbaVertically,
  fpsToGifDelayMs,
  generateGifFrameDelays,
  generateOrbitAngles,
  normalizeGifFilename,
  visibleOrbitBounds,
  exportOrbitGif,
} from './exportOrbitGif.ts';

const TAU = Math.PI * 2;

describe('orbit state restoration', () => {
  for (const orthographic of [false, true]) {
    const makeCamera = () => {
      const camera = orthographic
        ? new THREE.OrthographicCamera(-4, 7, 9, -3, 2, 900)
        : new THREE.PerspectiveCamera(38, 1.7, 2, 900);
      camera.position.set(20, 30, 40);
      camera.up.set(0, 0, 1);
      camera.zoom = 1.8;
      camera.setViewOffset(100, 100, 10, 20, 50, 60);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      return camera;
    };

    it(`restores independently mutated ${orthographic ? 'orthographic' : 'perspective'} view parameters`, () => {
      const object = new THREE.Group();
      object.position.set(1, 2, 3);
      object.rotation.set(0.2, 0.3, 0.4);
      object.scale.set(2, 3, 4);
      object.updateMatrixWorld(true);
      const camera = makeCamera();
      const parent = new THREE.Group();
      parent.add(camera);
      const child = new THREE.Group();
      camera.add(child);
      const controls = { enabled: false, target: new THREE.Vector3(3, 4, 5) };
      const saved = captureOrbitViewState(object, camera, controls);
      const cameraJson = camera.toJSON();
      object.position.setScalar(100);
      object.scale.setScalar(9);
      object.quaternion.identity();
      camera.position.setScalar(-100);
      camera.quaternion.identity();
      camera.up.set(1, 0, 0);
      camera.near = 30;
      camera.far = 40;
      camera.zoom = 7;
      camera.clearViewOffset();
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.fov = 100;
        camera.aspect = 3;
      } else {
        camera.left = -80;
        camera.right = 80;
        camera.top = 80;
        camera.bottom = -80;
      }
      controls.enabled = true;
      controls.target.setScalar(99);
      restoreOrbitViewState(object, camera, controls, saved);
      assert.deepEqual(camera.toJSON(), cameraJson);
      assert.equal(camera.parent, parent);
      assert.equal(camera.children[0], child);
      assert.deepEqual(object.position.toArray(), [1, 2, 3]);
      assert.deepEqual(object.scale.toArray(), [2, 3, 4]);
      assert.deepEqual(object.quaternion.toArray(), saved.quaternion.toArray());
      assert.equal(controls.enabled, false);
      assert.deepEqual(controls.target.toArray(), [3, 4, 5]);
    });

    for (const failure of [
      'scene render',
      'color pass',
      'readback',
      'encoder',
      'progress',
      'dispose',
    ]) {
      it(`restores ${orthographic ? 'orthographic' : 'perspective'} export after ${failure} failure and releases its lock`, async (t) => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('pink');
        scene.overrideMaterial = new THREE.MeshBasicMaterial();
        const object = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4));
        scene.add(object);
        const camera = makeCamera();
        const controls = { enabled: false, target: new THREE.Vector3(3, 4, 5) };
        const capture = captureRenderer(scene);
        const originalTarget = new THREE.WebGLRenderTarget(16, 16);
        capture.renderer.setRenderTarget(originalTarget, 2, 1);
        const renderState = captureOrbitRenderState(capture.renderer, scene);
        const cameraJson = camera.toJSON();
        const error = new Error(`injected ${failure}`);
        const disposals: THREE.WebGLRenderTarget[] = [];
        const dispose = THREE.WebGLRenderTarget.prototype.dispose;
        t.mock.method(
          THREE.WebGLRenderTarget.prototype,
          'dispose',
          function (this: THREE.WebGLRenderTarget) {
            disposals.push(this);
            dispose.call(this);
            if (failure === 'dispose' && disposals.length === 1) throw error;
          },
        );
        if (failure === 'scene render' || failure === 'color pass') {
          const render = capture.renderer.render.bind(capture.renderer);
          t.mock.method(
            capture.renderer,
            'render',
            (node: THREE.Object3D, frameCamera: THREE.Camera) => {
              if ((node === scene) === (failure === 'scene render'))
                throw error;
              render(node, frameCamera);
            },
          );
        }
        if (failure === 'readback')
          t.mock.method(capture.renderer, 'readRenderTargetPixels', () => {
            throw error;
          });
        if (failure === 'encoder') {
          // Fail inside the encoding adapter when it finalizes the GIF Blob.
          t.mock.method(globalThis, 'Blob', function () {
            throw error;
          });
        }
        await assert.rejects(
          exportOrbitGif({
            ...capture,
            scene,
            object,
            camera,
            controls,
            width: 2,
            height: 2,
            frameCount: 2,
            onProgress: ({ stage, completed }) => {
              if (
                failure === 'progress' &&
                stage === 'encoding' &&
                completed === 1
              )
                throw error;
            },
          }),
          (caught) => caught === error,
        );
        assert.deepEqual(
          captureOrbitRenderState(capture.renderer, scene),
          renderState,
        );
        assert.deepEqual(camera.toJSON(), cameraJson);
        assert.equal(controls.enabled, false);
        assert.deepEqual(controls.target.toArray(), [3, 4, 5]);
        assert.equal(disposals.length, 2);
        assert.ok(!disposals.includes(originalTarget));
        t.mock.restoreAll();
        const retry = await exportOrbitGif({
          ...capture,
          scene,
          object,
          camera,
          controls,
          width: 2,
          height: 2,
          frameCount: 1,
        });
        assert.equal(retry.type, 'image/gif');
        assert.deepEqual(
          captureOrbitRenderState(capture.renderer, scene),
          renderState,
        );
      });
    }
  }

  it('attempts remaining render-state restoration when one setter fails', () => {
    const scene = new THREE.Scene();
    const { renderer } = captureRenderer(scene);
    const saved = captureOrbitRenderState(renderer, scene);
    renderer.setRenderTarget(new THREE.WebGLRenderTarget<THREE.Texture>(2, 2));
    renderer.setScissorTest(false);
    const failure = mock.method(renderer, 'setClearColor', () => {
      throw new Error('context failure');
    });
    try {
      assert.throws(
        () => restoreOrbitRenderState(renderer, scene, saved),
        /context failure/,
      );
      assert.equal(renderer.getRenderTarget(), null);
      assert.equal(renderer.getScissorTest(), true);
    } finally {
      failure.mock.restore();
    }
  });
});

describe('visible orbit bounds', () => {
  it('uses ancestor transforms and excludes hidden subtrees and materials', () => {
    const parent = new THREE.Group();
    parent.position.set(10, 20, 30);
    const model = new THREE.Group();
    parent.add(model);
    const visible = new THREE.Mesh(
      new THREE.BoxGeometry(2, 4, 6),
      new THREE.MeshBasicMaterial(),
    );
    model.add(visible);
    const hidden = new THREE.Group();
    hidden.visible = false;
    hidden.add(new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000)));
    model.add(hidden);
    model.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(2000, 2000, 2000),
        new THREE.MeshBasicMaterial({ visible: false }),
      ),
    );
    const camera = new THREE.PerspectiveCamera();
    const bounds = visibleOrbitBounds(model, camera);
    assert.deepEqual(bounds.min.toArray(), [9, 18, 27]);
    assert.deepEqual(bounds.max.toArray(), [11, 22, 33]);
    parent.visible = false;
    assert.ok(visibleOrbitBounds(model, camera).isEmpty());
  });

  it('frames a user-selected center without clipping distant bounds', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(100, 0, 0),
      new THREE.Vector3(120, 20, 10),
    );
    const target = new THREE.Vector3(0, 0, 0);
    const framing = computeOrbitFraming({ box, aspect: 1, target });
    assert.deepEqual(framing.target.toArray(), [0, 0, 0]);
    assert.ok(framing.radius >= box.max.length());
    assert.ok(
      framing.perspective.far > framing.perspective.distance + box.max.length(),
    );
  });
});

function captureRenderer(scene: THREE.Scene) {
  let target: THREE.WebGLRenderTarget | null = null;
  let face = 0;
  let mip = 0;
  const viewport = new THREE.Vector4(2, 3, 800, 600);
  const scissor = new THREE.Vector4(4, 5, 600, 400);
  let scissorTest = true;
  const clearColor = new THREE.Color('#123456');
  let clearAlpha = 0.3;
  const positions: THREE.Vector3[] = [];
  const cameras: THREE.Camera[] = [];
  const targets = new Set<THREE.WebGLRenderTarget>();
  let colorPasses = 0;
  const renderer = {
    capabilities: { maxTextureSize: 4096, isWebGL2: true },
    extensions: { has: () => true },
    getContext: () => ({
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      getParameter: () => 4096,
    }),
    xr: { enabled: false },
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => mip,
    getViewport: (value: THREE.Vector4) => value.copy(viewport),
    getScissor: (value: THREE.Vector4) => value.copy(scissor),
    getScissorTest: () => scissorTest,
    getClearColor: (value: THREE.Color) => value.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    setClearColor: (value: THREE.ColorRepresentation, alpha: number) => {
      clearColor.set(value);
      clearAlpha = alpha;
    },
    setRenderTarget: (
      value: THREE.WebGLRenderTarget | null,
      nextFace = 0,
      nextMip = 0,
    ) => {
      target = value;
      face = nextFace;
      mip = nextMip;
      if (value) targets.add(value);
    },
    setViewport: (value: THREE.Vector4) => {
      viewport.copy(value);
    },
    setScissor: (value: THREE.Vector4) => {
      scissor.copy(value);
    },
    setScissorTest: (value: boolean) => {
      scissorTest = value;
    },
    clear: () => {},
    render: (object: THREE.Object3D, camera: THREE.Camera) => {
      assert.ok(target);
      if (object === scene) {
        positions.push(camera.position.clone());
        cameras.push(camera.clone());
        assert.equal(target.texture.type, THREE.HalfFloatType);
      } else {
        colorPasses += 1;
        assert.equal(target.texture.type, THREE.UnsignedByteType);
      }
    },
    readRenderTargetPixels: (
      _target: THREE.WebGLRenderTarget,
      _x: number,
      _y: number,
      width: number,
      height: number,
      pixels: Uint8Array,
    ) => {
      assert.equal(pixels.length, width * height * 4);
      pixels.fill(0); // Fully transparent capture should become the requested background.
    },
  };
  return {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    positions,
    cameras,
    targets,
    getColorPasses: () => colorPasses,
  };
}

describe('orbit capture pipeline', () => {
  it('exports one PNG frame along the current view direction', async () => {
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const oldImageData = Object.getOwnPropertyDescriptor(
      globalThis,
      'ImageData',
    );
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({
          getContext: () => ({ putImageData: () => {} }),
          toBlob: (callback: (blob: Blob) => void, type: string) =>
            callback(new Blob([], { type })),
        }),
      },
    });
    Object.defineProperty(globalThis, 'ImageData', {
      configurable: true,
      value: class {},
    });
    try {
      const scene = new THREE.Scene();
      const object = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4));
      object.position.set(100, 0, 0);
      scene.add(object);
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(10, 20, 30);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      const direction = camera.getWorldDirection(new THREE.Vector3());
      const savedCamera = camera.toJSON();
      const capture = captureRenderer(scene);
      const blob = await exportOrbitGif({
        ...capture,
        scene,
        object,
        camera,
        format: 'png',
        width: 2,
        height: 2,
      });
      assert.equal(blob.type, 'image/png');
      assert.equal(capture.cameras.length, 1);
      assert.ok(
        capture.cameras[0]
          .getWorldDirection(new THREE.Vector3())
          .distanceTo(direction) < 1e-10,
      );
      assert.deepEqual(camera.toJSON(), savedCamera);
    } finally {
      for (const [key, descriptor] of [
        ['document', oldDocument],
        ['ImageData', oldImageData],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  for (const camera of [
    new THREE.PerspectiveCamera(45, 2, 0.1, 1000),
    new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000),
  ]) {
    it(`captures a full orbit using ${camera.type} without modifying the model or camera`, async () => {
      const scene = new THREE.Scene();
      const background = new THREE.Color('pink');
      scene.background = background;
      const object = new THREE.Mesh(new THREE.BoxGeometry(20, 2, 3));
      object.rotation.x = -Math.PI / 2;
      scene.add(object);
      camera.position.set(20, 30, 40);
      camera.zoom = 2;
      camera.updateMatrixWorld(true);
      const savedCamera = camera.toJSON();
      const savedRotation = object.quaternion.clone();
      const controls = { enabled: true, target: new THREE.Vector3(1, 2, 3) };
      const capture = captureRenderer(scene);
      const disposed = new Set<THREE.WebGLRenderTarget>();
      const blob = await exportOrbitGif({
        ...capture,
        scene,
        object,
        camera,
        controls,
        width: 2,
        height: 2,
        onProgress: (progress) => {
          assert.equal(scene.background, background);
          assert.equal(capture.renderer.getRenderTarget(), null);
          assert.equal(controls.enabled, false);
          if (progress.stage === 'rendering' && progress.completed === 1) {
            for (const rt of capture.targets)
              rt.addEventListener('dispose', () => disposed.add(rt));
          }
        },
      });
      assert.equal(blob.type, 'image/gif');
      assert.equal(capture.positions.length, 36);
      assert.equal(capture.getColorPasses(), 36);
      assert.ok(capture.positions[0].distanceTo(capture.positions[35]) > 0.1);
      assert.equal(disposed.size, 2);
      assert.deepEqual(camera.toJSON(), savedCamera);
      assert.deepEqual(object.quaternion.toArray(), savedRotation.toArray());
      assert.equal(controls.enabled, true);
      assert.deepEqual(controls.target.toArray(), [1, 2, 3]);
      const bounds = visibleOrbitBounds(object, camera);
      for (const frameCamera of capture.cameras) {
        for (const x of [bounds.min.x, bounds.max.x])
          for (const y of [bounds.min.y, bounds.max.y])
            for (const z of [bounds.min.z, bounds.max.z]) {
              const projected = new THREE.Vector3(x, y, z).project(frameCamera);
              assert.ok(
                Math.abs(projected.x) <= 0.800001 &&
                  Math.abs(projected.y) <= 0.800001,
              );
              assert.ok(Math.abs(projected.z) <= 1);
            }
      }
    });
  }
});

describe('generateOrbitAngles', () => {
  it('creates 36 evenly spaced frames without a duplicate 360-degree frame', () => {
    const angles = generateOrbitAngles(36);
    assert.equal(angles.length, 36);
    assert.equal(angles[0], 0);
    assert.ok(Math.abs(angles[1] - TAU / 36) < 1e-12);
    assert.ok(Math.abs(angles.at(-1)! - (TAU * 35) / 36) < 1e-12);
    assert.ok(angles.every((angle) => angle < TAU));
  });

  it('preserves a caller-provided starting azimuth', () => {
    assert.deepEqual(generateOrbitAngles(4, Math.PI / 4), [
      Math.PI / 4,
      (3 * Math.PI) / 4,
      (5 * Math.PI) / 4,
      (7 * Math.PI) / 4,
    ]);
  });
});

describe('GIF frame timing', () => {
  it('rounds an individual 24 fps delay to GIF centiseconds', () => {
    assert.equal(fpsToGifDelayMs(24), 40);
  });

  it('distributes centisecond rounding so 36 frames average exactly 24 fps', () => {
    const delays = generateGifFrameDelays(24, 36);
    assert.equal(delays.length, 36);
    assert.ok(delays.every((delay) => delay === 40 || delay === 50));
    assert.equal(
      delays.reduce((sum, delay) => sum + delay, 0),
      1500,
    );
  });
});

describe('normalizeGifFilename', () => {
  it('adds one gif extension and strips unsafe path/name characters', () => {
    assert.equal(
      normalizeGifFilename(' C:\\examples\\Iris waste:basket.GIF '),
      'Iris-waste-basket.gif',
    );
  });

  it('uses the default for an empty name', () => {
    assert.equal(normalizeGifFilename('  '), 'iris-example-orbit.gif');
  });
});

describe('flipRgbaVertically', () => {
  it('reverses rows without changing pixels inside each row', () => {
    const bottomUp = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    assert.deepEqual(
      [...flipRgbaVertically(bottomUp, 2, 2)],
      [9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  it('rejects a buffer whose dimensions do not match', () => {
    assert.throws(
      () => flipRgbaVertically(new Uint8Array(4), 2, 2),
      /does not match 2x2/,
    );
  });
});

describe('computeOrbitFraming', () => {
  it('centers and safely frames a tall box that is offset from the origin', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(8, -30, -7),
      new THREE.Vector3(12, 70, -3),
    );
    const framing = computeOrbitFraming({ box, aspect: 1 });

    assert.deepEqual(framing.target.toArray(), [10, 20, -5]);
    assert.ok(framing.maxProjectedHalfHeight > 40);
    assert.ok(framing.perspective.distance > framing.radius);
    assert.ok(framing.perspective.near > 0);
    assert.ok(framing.perspective.far > framing.perspective.near);
    assert.ok(
      framing.orthographic.halfHeight >= framing.maxProjectedHalfHeight / 0.8,
    );
  });

  it('uses the horizontal constraint for a wide box', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(-100, -2, -3),
      new THREE.Vector3(100, 2, 3),
    );
    const framing = computeOrbitFraming({ box, aspect: 1 });

    assert.ok(framing.maxProjectedHalfWidth > 90);
    assert.ok(
      framing.orthographic.halfWidth >= framing.maxProjectedHalfWidth / 0.8,
    );
  });

  it('rejects an empty bounding box', () => {
    assert.throws(
      () => computeOrbitFraming({ box: new THREE.Box3(), aspect: 1 }),
      /empty bounding box/,
    );
  });
});

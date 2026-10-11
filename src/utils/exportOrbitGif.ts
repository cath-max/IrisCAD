import * as THREE from 'three';
import {
  captureOrbitRenderState,
  restoreOrbitRenderState,
  captureOrbitViewState,
  restoreOrbitViewState,
  runOrbitCleanup,
} from './orbitGifState.ts';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const GIF_TIME_UNIT_MS = 10;
const DEFAULT_FILENAME = 'iris-example-orbit.gif';

export interface OrbitFramingOptions {
  box: THREE.Box3;
  aspect: number;
  verticalFovDegrees?: number;
  fillRatio?: number;
  polarAngleDegrees?: number;
  frameCount?: number;
  startAngleRadians?: number;
  /** Optional world-space orbit center; bounds remain fully contained. */
  target?: THREE.Vector3;
}

export interface OrbitFraming {
  target: THREE.Vector3;
  radius: number;
  maxProjectedHalfWidth: number;
  maxProjectedHalfHeight: number;
  perspective: {
    distance: number;
    near: number;
    far: number;
  };
  orthographic: {
    distance: number;
    halfWidth: number;
    halfHeight: number;
    near: number;
    far: number;
  };
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}

/** Return evenly spaced orbit angles in [start, start + 2π), never 2π itself. */
export function generateOrbitAngles(
  frameCount: number,
  startAngleRadians = 0,
): number[] {
  assertPositiveInteger(frameCount, 'frameCount');
  if (!Number.isFinite(startAngleRadians)) {
    throw new RangeError('startAngleRadians must be finite.');
  }
  return Array.from(
    { length: frameCount },
    (_, index) => startAngleRadians + (TAU * index) / frameCount,
  );
}

/** GIF delays are stored in 10 ms units, so one frame must be rounded. */
export function fpsToGifDelayMs(fps: number): number {
  assertPositiveFinite(fps, 'fps');
  if (fps > 100) {
    throw new RangeError('GIF cannot represent frame rates above 100 fps.');
  }
  return Math.max(
    GIF_TIME_UNIT_MS,
    Math.round(1000 / fps / GIF_TIME_UNIT_MS) * GIF_TIME_UNIT_MS,
  );
}

/**
 * Distribute GIF's 10 ms timing error across the animation. For example,
 * 24 fps uses a mix of 40 ms and 50 ms frames instead of drifting at 25 fps.
 */
export function generateGifFrameDelays(
  fps: number,
  frameCount: number,
): number[] {
  fpsToGifDelayMs(fps);
  assertPositiveInteger(frameCount, 'frameCount');

  let previousRoundedUnits = 0;
  return Array.from({ length: frameCount }, (_, index) => {
    const roundedUnits = Math.round(((index + 1) * 100) / fps);
    const delayUnits = Math.max(1, roundedUnits - previousRoundedUnits);
    previousRoundedUnits += delayUnits;
    return delayUnits * GIF_TIME_UNIT_MS;
  });
}

export function normalizeGifFilename(
  filename: string | undefined,
  fallback = DEFAULT_FILENAME,
): string {
  const fallbackStem = sanitizeFilenameStem(fallback) || 'iris-example-orbit';
  const stem = sanitizeFilenameStem(filename ?? '') || fallbackStem;
  return `${stem}.gif`;
}

function sanitizeFilenameStem(filename: string): string {
  const basename = filename.trim().split(/[\\/]/).at(-1) ?? '';
  const withoutControlCharacters = Array.from(basename, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
  return withoutControlCharacters
    .replace(/\.gif$/i, '')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '');
}

/** Convert bottom-up WebGL RGBA rows into the top-down order expected by GIF. */
export function flipRgbaVertically(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');
  const rowBytes = width * 4;
  if (rgba.length !== rowBytes * height) {
    throw new RangeError(
      `RGBA buffer length ${rgba.length} does not match ${width}x${height}.`,
    );
  }

  const flipped = new Uint8Array(rgba.length);
  for (let sourceRow = 0; sourceRow < height; sourceRow += 1) {
    const targetRow = height - sourceRow - 1;
    flipped.set(
      rgba.subarray(sourceRow * rowBytes, (sourceRow + 1) * rowBytes),
      targetRow * rowBytes,
    );
  }
  return flipped;
}

/**
 * Compute one framing solution that contains every bounding-box corner at
 * every exported orbit angle. The polar angle is measured down from +Y.
 */
export function computeOrbitFraming({
  box,
  aspect,
  verticalFovDegrees = 45,
  fillRatio = 0.8,
  polarAngleDegrees = 62,
  frameCount = 36,
  startAngleRadians = 0,
  target: requestedTarget,
}: OrbitFramingOptions): OrbitFraming {
  if (box.isEmpty()) {
    throw new RangeError('Cannot frame an empty bounding box.');
  }
  assertPositiveFinite(aspect, 'aspect');
  assertPositiveFinite(verticalFovDegrees, 'verticalFovDegrees');
  if (verticalFovDegrees >= 179) {
    throw new RangeError('verticalFovDegrees must be less than 179 degrees.');
  }
  if (!Number.isFinite(fillRatio) || fillRatio <= 0 || fillRatio >= 1) {
    throw new RangeError('fillRatio must be greater than 0 and less than 1.');
  }
  if (
    !Number.isFinite(polarAngleDegrees) ||
    polarAngleDegrees <= 0 ||
    polarAngleDegrees >= 180
  ) {
    throw new RangeError(
      'polarAngleDegrees must be greater than 0 and less than 180.',
    );
  }

  if (
    ![
      ...box.min.toArray(),
      ...box.max.toArray(),
      ...(requestedTarget?.toArray() ?? []),
    ].every(Number.isFinite)
  ) {
    throw new RangeError('Bounds and orbit target must be finite.');
  }
  const target = requestedTarget?.clone() ?? box.getCenter(new THREE.Vector3());
  const corners = boundingBoxCorners(box).map((corner) => corner.sub(target));
  const radius = Math.max(...corners.map((corner) => corner.length()), 1e-6);
  const angles = generateOrbitAngles(frameCount, startAngleRadians);
  const polar = THREE.MathUtils.degToRad(polarAngleDegrees);
  const sinPolar = Math.sin(polar);
  const cosPolar = Math.cos(polar);
  const worldUp = new THREE.Vector3(0, 1, 0);
  const tanVertical = Math.tan(
    THREE.MathUtils.degToRad(verticalFovDegrees) / 2,
  );
  const tanHorizontal = tanVertical * aspect;

  let maxProjectedHalfWidth = 0;
  let maxProjectedHalfHeight = 0;
  let perspectiveDistance = 0;

  for (const angle of angles) {
    const cameraDirection = new THREE.Vector3(
      sinPolar * Math.cos(angle),
      cosPolar,
      sinPolar * Math.sin(angle),
    ).normalize();
    const forward = cameraDirection.clone().negate();
    const right = forward.clone().cross(worldUp).normalize();
    const screenUp = right.clone().cross(forward).normalize();

    for (const corner of corners) {
      const projectedX = Math.abs(corner.dot(right));
      const projectedY = Math.abs(corner.dot(screenUp));
      const towardCamera = corner.dot(cameraDirection);
      maxProjectedHalfWidth = Math.max(maxProjectedHalfWidth, projectedX);
      maxProjectedHalfHeight = Math.max(maxProjectedHalfHeight, projectedY);
      perspectiveDistance = Math.max(
        perspectiveDistance,
        towardCamera + projectedX / (tanHorizontal * fillRatio),
        towardCamera + projectedY / (tanVertical * fillRatio),
      );
    }
  }

  perspectiveDistance = Math.max(perspectiveDistance, radius * 1.01);
  const orthographicHalfHeight = Math.max(
    maxProjectedHalfHeight / fillRatio,
    maxProjectedHalfWidth / (fillRatio * aspect),
    1e-6,
  );
  const orthographicDistance = Math.max(radius * 2.5, 1e-6);

  return {
    target,
    radius,
    maxProjectedHalfWidth,
    maxProjectedHalfHeight,
    perspective: clippingRange(perspectiveDistance, radius),
    orthographic: {
      ...clippingRange(orthographicDistance, radius),
      halfWidth: orthographicHalfHeight * aspect,
      halfHeight: orthographicHalfHeight,
    },
  };
}

function clippingRange(
  distance: number,
  radius: number,
): { distance: number; near: number; far: number } {
  const epsilon = Math.max(radius * 1e-4, 1e-8);
  const near = Math.max(epsilon, distance - radius * 1.05);
  return {
    distance,
    near,
    far: Math.max(near + epsilon, distance + radius * 1.05),
  };
}

function boundingBoxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

export interface OrbitControlsLike {
  enabled: boolean;
  target: THREE.Vector3;
}

export interface OrbitGifProgress {
  stage: 'rendering' | 'encoding';
  completed: number;
  total: number;
}

export interface OrbitGifOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** The displayed Mesh or assembly wrapper, including its world transforms. */
  object: THREE.Object3D;
  controls?: OrbitControlsLike;
  width?: number;
  height?: number;
  frameCount?: number;
  fps?: number;
  /** Historical name: polar angle down from +Y; 62 means 28 above the horizon. */
  elevationDegrees?: number;
  background?: THREE.ColorRepresentation;
  /** Reserved for the caller's downloadFile; this function returns a Blob only. */
  filename?: string;
  target?: THREE.Vector3;
  /** Supersampling factor >= 1; width/height always mean final GIF dimensions. */
  pixelRatio?: number;
  /** Fraction of the frame available to the model over the complete orbit. */
  fillRatio?: number;
  onProgress?: (progress: OrbitGifProgress) => void;
  /** Copy of final opaque sRGB pixels, before GIF palette quantization. */
  onFirstFrame?: (rgba: Uint8Array, width: number, height: number) => void;
  /** PNG captures one frame along the current camera direction. */
  format?: 'gif' | 'png';
}

/** Exclude hidden subtrees/materials and account for all ancestor transforms. */
export function visibleOrbitBounds(
  object: THREE.Object3D,
  camera: THREE.Camera,
): THREE.Box3 {
  const bounds = new THREE.Box3();
  for (
    let ancestor: THREE.Object3D | null = object;
    ancestor;
    ancestor = ancestor.parent
  ) {
    if (!ancestor.visible) return bounds;
  }
  object.updateWorldMatrix(true, true);
  object.traverseVisible((node) => {
    if (!(node instanceof THREE.Mesh) || !node.layers.test(camera.layers))
      return;
    const materials = Array.isArray(node.material)
      ? node.material
      : [node.material];
    if (materials.every((material) => !material.visible)) return;
    // Current CAD previews use static meshes (including InstancedMesh support).
    // Never expandByObject(node): it recursively includes hidden descendants.
    if (node instanceof THREE.InstancedMesh) {
      if (!node.boundingBox) node.computeBoundingBox();
      if (node.boundingBox)
        bounds.union(node.boundingBox.clone().applyMatrix4(node.matrixWorld));
    } else {
      if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
      if (node.geometry.boundingBox)
        bounds.union(
          node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld),
        );
    }
  });
  return bounds;
}

function createFrameResizer(
  width: number,
  height: number,
  renderWidth: number,
  renderHeight: number,
) {
  if (width === renderWidth && height === renderHeight)
    return (rgba: Uint8Array) => rgba;
  const createCanvas = (w: number, h: number) => {
    if (typeof OffscreenCanvas !== 'undefined')
      return new OffscreenCanvas(w, h);
    if (typeof document === 'undefined')
      throw new Error('Supersampling requires a browser 2D canvas.');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  };
  const source = createCanvas(renderWidth, renderHeight);
  const destination = createCanvas(width, height);
  const sourceContext = source.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  const destinationContext = destination.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!sourceContext || !destinationContext)
    throw new Error('Could not create GIF resize contexts.');
  destinationContext.imageSmoothingEnabled = true;
  destinationContext.imageSmoothingQuality = 'high';
  return (rgba: Uint8Array) => {
    sourceContext.putImageData(
      new ImageData(new Uint8ClampedArray(rgba), renderWidth, renderHeight),
      0,
      0,
    );
    destinationContext.drawImage(source, 0, 0, width, height);
    return new Uint8Array(
      destinationContext.getImageData(0, 0, width, height).data,
    );
  };
}

const activeOrbitRenderers = new WeakSet<THREE.WebGLRenderer>();

/**
 * DEV export core. Caller must pause R3F's frameloop for the duration and resume
 * it in finally. Uses the existing scene/meshes and an unattached camera clone;
 * never calls CAD, Worker, mesh builders, React, or download APIs.
 */
export async function exportOrbitGif({
  renderer,
  scene,
  camera,
  object,
  controls,
  width = 520,
  height = 520,
  frameCount = 36,
  fps = 24,
  elevationDegrees = 62,
  background = '#f2f2f4',
  target,
  pixelRatio = 1,
  fillRatio = 0.8,
  onProgress,
  onFirstFrame,
  format = 'gif',
}: OrbitGifOptions): Promise<Blob> {
  if (format === 'png') frameCount = 1;
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');
  assertPositiveFinite(pixelRatio, 'pixelRatio');
  if (pixelRatio < 1 || width > 65535 || height > 65535)
    throw new RangeError('Invalid GIF dimensions or pixelRatio.');
  const delays = generateGifFrameDelays(fps, frameCount);
  if (delays.some((delay) => delay > 655350))
    throw new RangeError('GIF frame delay exceeds the format limit.');
  if (
    !(
      camera instanceof THREE.PerspectiveCamera ||
      camera instanceof THREE.OrthographicCamera
    )
  ) {
    throw new TypeError(
      'Orbit export requires a perspective or orthographic camera.',
    );
  }
  if (activeOrbitRenderers.has(renderer))
    throw new Error('An orbit export is already using this renderer.');
  let parent: THREE.Object3D | null = object;
  while (parent && parent !== scene) parent = parent.parent;
  if (!parent)
    throw new Error('The displayed object must belong to the supplied scene.');
  const renderWidth = Math.ceil(width * pixelRatio);
  const renderHeight = Math.ceil(height * pixelRatio);
  const gl = renderer.getContext();
  const maxSize = Math.min(
    renderer.capabilities.maxTextureSize,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
  );
  if (
    !Number.isSafeInteger(renderWidth) ||
    !Number.isSafeInteger(renderHeight) ||
    renderWidth > maxSize ||
    renderHeight > maxSize
  ) {
    throw new RangeError(
      'Requested capture exceeds the renderer texture limits.',
    );
  }
  if (
    !renderer.capabilities.isWebGL2 ||
    !renderer.extensions.has('EXT_color_buffer_float')
  ) {
    throw new Error(
      'Orbit export requires WebGL2 with floating-point color targets.',
    );
  }
  const bounds = visibleOrbitBounds(object, camera);
  const center = target ?? bounds.getCenter(new THREE.Vector3());
  const currentPosition = camera
    .getWorldPosition(new THREE.Vector3())
    .sub(center);
  if (format === 'png') {
    camera.getWorldDirection(currentPosition).negate();
    elevationDegrees = THREE.MathUtils.clamp(
      THREE.MathUtils.radToDeg(
        Math.acos(THREE.MathUtils.clamp(currentPosition.y, -1, 1)),
      ),
      0.001,
      179.999,
    );
  }
  const startAngleRadians = Math.atan2(currentPosition.z, currentPosition.x);
  const framing = computeOrbitFraming({
    box: bounds,
    fillRatio,
    aspect: width / height,
    target,
    verticalFovDegrees:
      camera instanceof THREE.PerspectiveCamera ? camera.fov : 45,
    polarAngleDegrees: elevationDegrees,
    frameCount,
    startAngleRadians,
  });
  const orbitCamera = camera.clone();
  orbitCamera.parent = null;
  orbitCamera.matrixAutoUpdate = true;
  orbitCamera.scale.setScalar(1);
  orbitCamera.up.set(0, 1, 0);
  orbitCamera.zoom = 1;
  orbitCamera.clearViewOffset();
  if (orbitCamera instanceof THREE.PerspectiveCamera) {
    orbitCamera.aspect = width / height;
    orbitCamera.filmOffset = 0;
    orbitCamera.near = framing.perspective.near;
    orbitCamera.far = framing.perspective.far;
  } else {
    const { halfWidth, halfHeight, near, far } = framing.orthographic;
    Object.assign(orbitCamera, {
      left: -halfWidth,
      right: halfWidth,
      top: halfHeight,
      bottom: -halfHeight,
      near,
      far,
    });
  }
  orbitCamera.updateProjectionMatrix();
  if (format === 'png') {
    // Include the grounding plane in depth clipping, but not model framing.
    const sceneBounds = visibleOrbitBounds(scene, camera);
    const depthRadius = Math.max(
      ...boundingBoxCorners(sceneBounds).map((point) =>
        point.distanceTo(framing.target),
      ),
    );
    const distance =
      orbitCamera instanceof THREE.PerspectiveCamera
        ? framing.perspective.distance
        : framing.orthographic.distance;
    const clipping = clippingRange(distance, depthRadius);
    orbitCamera.near = clipping.near;
    orbitCamera.far = clipping.far;
    orbitCamera.updateProjectionMatrix();
  }
  const resize = createFrameResizer(width, height, renderWidth, renderHeight);
  const backgroundColor = new THREE.Color(background).convertLinearToSRGB();
  const backgroundBytes = backgroundColor
    .toArray()
    .map((v) => Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255));
  const original = captureOrbitRenderState(renderer, scene);
  const originalView = captureOrbitViewState(object, camera, controls);
  const restore = () => restoreOrbitRenderState(renderer, scene, original);
  let linearTarget: THREE.WebGLRenderTarget | undefined;
  let outputTarget: THREE.WebGLRenderTarget | undefined;
  let outputPass: OutputPass | undefined;
  activeOrbitRenderers.add(renderer);
  try {
    if (controls) controls.enabled = false;
    linearTarget = new THREE.WebGLRenderTarget(renderWidth, renderHeight, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    outputTarget = new THREE.WebGLRenderTarget(renderWidth, renderHeight, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
    });
    outputPass = new OutputPass();
    // Transparent edge/shadow pixels are premultiplied in the linear target.
    // Unpremultiply before nonlinear tone mapping; composite in sRGB below.
    outputPass.material.fragmentShader =
      outputPass.material.fragmentShader.replace(
        'gl_FragColor = texture2D( tDiffuse, vUv );',
        'gl_FragColor = texture2D( tDiffuse, vUv );\nif (gl_FragColor.a > 0.0) gl_FragColor.rgb /= gl_FragColor.a;',
      );
    const pixels = new Uint8Array(renderWidth * renderHeight * 4);
    const frames: Uint8Array[] = [];
    const polar = THREE.MathUtils.degToRad(elevationDegrees);
    const distance =
      orbitCamera instanceof THREE.PerspectiveCamera
        ? framing.perspective.distance
        : framing.orthographic.distance;
    onProgress?.({ stage: 'rendering', completed: 0, total: frameCount });
    for (const angle of generateOrbitAngles(frameCount, startAngleRadians)) {
      orbitCamera.position
        .set(
          Math.sin(polar) * Math.cos(angle),
          Math.cos(polar),
          Math.sin(polar) * Math.sin(angle),
        )
        .multiplyScalar(distance)
        .add(framing.target);
      orbitCamera.lookAt(framing.target);
      orbitCamera.updateMatrixWorld(true);
      try {
        scene.background = null;
        renderer.xr.enabled = false;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(linearTarget);
        renderer.clear(true, true, true);
        renderer.render(scene, orbitCamera);
        // r160 disables tone mapping for normal render targets. OutputPass
        // preserves the renderer's tone mapping/exposure and writes sRGB bytes.
        outputPass.render(renderer, outputTarget, linearTarget, 0, false);
        renderer.readRenderTargetPixels(
          outputTarget,
          0,
          0,
          renderWidth,
          renderHeight,
          pixels,
        );
      } finally {
        restore(); // safe before callbacks or any event-loop yield
      }
      const rgba = flipRgbaVertically(pixels, renderWidth, renderHeight);
      // Composite onto the exact requested sRGB background, unaffected by tone
      // mapping. OutputPass now supplies straight RGB; make the GIF opaque.
      for (let i = 0; i < rgba.length; i += 4) {
        const alpha = rgba[i + 3] / 255;
        for (let channel = 0; channel < 3; channel += 1) {
          rgba[i + channel] = Math.min(
            255,
            Math.round(
              rgba[i + channel] * alpha +
                backgroundBytes[channel] * (1 - alpha),
            ),
          );
        }
        rgba[i + 3] = 255;
      }
      frames.push(resize(rgba));
      if (frames.length === 1 && onFirstFrame)
        onFirstFrame(frames[0].slice(), width, height);
      onProgress?.({
        stage: 'rendering',
        completed: frames.length,
        total: frameCount,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (format === 'png') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create PNG canvas.');
      context.putImageData(
        new ImageData(new Uint8ClampedArray(frames[0]), width, height),
        0,
        0,
      );
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error('Could not encode PNG.')),
          'image/png',
        ),
      );
    }
    const { encodeOrbitGifFrames } = await import('./orbitGifEncoding.ts');
    onProgress?.({ stage: 'encoding', completed: 0, total: frameCount });
    return await encodeOrbitGifFrames({
      frames,
      width,
      height,
      delays,
      onProgress: (completed, total) =>
        onProgress?.({ stage: 'encoding', completed, total }),
    });
  } finally {
    runOrbitCleanup([
      restore,
      () => restoreOrbitViewState(object, camera, controls, originalView),
      () => linearTarget?.dispose(),
      () => outputTarget?.dispose(),
      () => outputPass?.dispose(),
      () => {
        activeOrbitRenderers.delete(renderer);
      },
    ]);
  }
}

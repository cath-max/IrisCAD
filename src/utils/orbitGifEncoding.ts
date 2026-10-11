/** Internal to the DEV orbit exporter. No production entry should import this module. */
import { buildOrbitPalette, mapOrbitPalette } from './orbitGifPalette.ts';
export type OrbitGifFrame = Uint8Array | Uint8ClampedArray;

export interface OrbitGifEncodingOptions {
  /** Top-down, opaque RGBA frames, already composited onto the export background. */
  frames: readonly OrbitGifFrame[];
  width: number;
  height: number;
  /** Delays in milliseconds, exactly representable in GIF's 10 ms units. */
  delays: readonly number[];
  maxColors?: number;
  maxSamplePixels?: number;
  onProgress?: (completed: number, total: number) => void;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

/** Bounded, deterministic sampling with equal representation from every frame. */
export function sampleOrbitGifPixels(
  frames: readonly OrbitGifFrame[],
  maxSamplePixels = 65_536,
): Uint8Array {
  positiveInteger(maxSamplePixels, 'maxSamplePixels');
  if (frames.length === 0 || maxSamplePixels < frames.length) {
    throw new RangeError('Sampling requires at least one pixel per frame.');
  }
  const frameBytes = frames[0].length;
  if (
    frameBytes === 0 ||
    frameBytes % 4 !== 0 ||
    frames.some((frame) => frame.length !== frameBytes)
  ) {
    throw new RangeError(
      'Frames must contain equally sized, nonempty RGBA data.',
    );
  }
  const pixelsPerFrame = frameBytes / 4;
  const sampleCount = Math.min(maxSamplePixels, pixelsPerFrame * frames.length);
  const samples = new Uint8Array(sampleCount * 4);
  let outputOffset = 0;
  frames.forEach((frame, frameIndex) => {
    const count =
      Math.floor(sampleCount / frames.length) +
      (frameIndex < sampleCount % frames.length ? 1 : 0);
    for (let i = 0; i < count; i += 1) {
      const pixel = Math.floor(((i + 0.5) * pixelsPerFrame) / count);
      samples.set(frame.subarray(pixel * 4, pixel * 4 + 4), outputOffset);
      outputOffset += 4;
    }
  });
  return samples;
}

/** Encode captured frames; performs no CAD work, rendering, or downloading. */
export async function encodeOrbitGifFrames({
  frames,
  width,
  height,
  delays,
  maxColors = 256,
  maxSamplePixels = 65_536,
  onProgress,
}: OrbitGifEncodingOptions): Promise<Blob> {
  positiveInteger(width, 'width');
  positiveInteger(height, 'height');
  if (width > 65_535 || height > 65_535) {
    throw new RangeError('GIF dimensions must fit unsigned 16-bit integers.');
  }
  if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) {
    throw new RangeError('maxColors must be an integer between 2 and 256.');
  }
  if (frames.some((frame) => frame.length !== width * height * 4)) {
    throw new RangeError('Frame data does not match the GIF dimensions.');
  }
  if (
    delays.length !== frames.length ||
    delays.some(
      (delay) =>
        !Number.isInteger(delay) ||
        delay < 10 ||
        delay > 655_350 ||
        delay % 10 !== 0,
    )
  ) {
    throw new RangeError(
      'Each frame needs a delay of 10–655350 ms in 10 ms units.',
    );
  }
  const samples = sampleOrbitGifPixels(frames, maxSamplePixels);
  // Lazy even within this module; the future UI must also be DEV-only.
  const module = await import('gifenc');
  // Vite resolves the ESM build; Node's native test runner resolves CJS,
  // whose named exports live on the default namespace instead.
  const { GIFEncoder } =
    typeof module.quantize === 'function'
      ? module
      : (module as unknown as { default: typeof module }).default;
  const palette = buildOrbitPalette(samples, maxColors);
  const encoder = GIFEncoder();
  for (let i = 0; i < frames.length; i += 1) {
    encoder.writeFrame(mapOrbitPalette(frames[i], palette), width, height, {
      ...(i === 0 ? { palette, repeat: 0 } : {}),
      delay: delays[i],
    });
    onProgress?.(i + 1, frames.length);
    // Release the indexed frame before yielding to progress UI updates.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  encoder.finish();
  return new Blob([new Uint8Array(encoder.bytes())], { type: 'image/gif' });
}

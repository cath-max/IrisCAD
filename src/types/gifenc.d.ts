/** Minimal surface used by the DEV adapter; gifenc 1.0.3 ships no declarations. */
declare module 'gifenc' {
  export type Palette = number[][];
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' },
  ): Palette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: 'rgb565',
  ): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(
      indexed: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: Palette; repeat?: number; delay?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  encodeOrbitGifFrames,
  sampleOrbitGifPixels,
} from './orbitGifEncoding.ts';
import { generateGifFrameDelays } from './exportOrbitGif.ts';
import { buildOrbitPalette, mapOrbitPalette } from './orbitGifPalette.ts';

describe('full RGB palette precision', () => {
  it('preserves all 256 grayscale shades instead of merging RGB565 neighbors', () => {
    const rgba = new Uint8Array(
      Array.from({ length: 256 }, (_, n) => [n, n, n, 255]).flat(),
    );
    const palette = buildOrbitPalette(rgba, 256);
    const indexed = mapOrbitPalette(rgba, palette);
    assert.equal(new Set(indexed).size, 256);
    for (let n = 0; n < 256; n++)
      assert.deepEqual(palette[indexed[n]], [n, n, n]);
  });

  it('respects the color limit and handles unaligned views without changing pixels', () => {
    const backing = new Uint8Array([
      99, 120, 128, 136, 255, 121, 129, 137, 255, 250, 10, 20, 255, 99,
    ]);
    const rgba = backing.subarray(1, 13);
    const before = rgba.slice();
    const exact = buildOrbitPalette(rgba, 256);
    assert.deepEqual(
      [...mapOrbitPalette(rgba, exact)].map((i) => exact[i]),
      [
        [120, 128, 136],
        [121, 129, 137],
        [250, 10, 20],
      ],
    );
    assert.equal(buildOrbitPalette(rgba, 2).length, 2);
    assert.deepEqual(rgba, before);
    assert.deepEqual(buildOrbitPalette(rgba, 2), buildOrbitPalette(rgba, 2));
  });
});

const red = new Uint8Array([255, 0, 0, 255]);
const blue = new Uint8Array([0, 0, 255, 255]);

describe('orbit GIF sampling', () => {
  it('includes every frame within budget without mutating source data', () => {
    const frames = Array.from(
      { length: 3 },
      (_, i) =>
        new Uint8Array(
          Array.from({ length: 100 }, () => [i * 100, 0, 0, 255]).flat(),
        ),
    );
    const before = frames.map((frame) => frame.slice());
    const samples = sampleOrbitGifPixels(frames, 8);
    assert.equal(samples.length, 32);
    assert.deepEqual(
      Array.from(samples).filter((_, i) => i % 4 === 0),
      [0, 0, 0, 100, 100, 100, 200, 200],
    );
    assert.deepEqual(frames, before);
    assert.deepEqual(sampleOrbitGifPixels(frames, 8), samples);
  });

  it('keeps all pixels for small frames and respects typed-array subviews', () => {
    const backing = new Uint8Array([9, ...red, 8]);
    assert.deepEqual(
      sampleOrbitGifPixels([backing.subarray(1, 5), blue]),
      new Uint8Array([...red, ...blue]),
    );
  });

  it('rejects empty, malformed, inconsistent frames and insufficient budgets', () => {
    for (const frames of [
      [],
      [new Uint8Array()],
      [new Uint8Array(3)],
      [red, new Uint8Array(8)],
    ]) {
      assert.throws(() => sampleOrbitGifPixels(frames), RangeError);
    }
    assert.throws(() => sampleOrbitGifPixels([red, blue], 1), RangeError);
  });
});

/** Parse container blocks, independently of gifenc, to verify emitted metadata. */
function inspectGif(bytes: Uint8Array) {
  const word = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 6)), 'GIF89a');
  const globalTableSize = 3 * 2 ** ((bytes[10] & 7) + 1);
  assert.ok(bytes[10] & 0x80);
  const palette = bytes.slice(13, 13 + globalTableSize);
  const delays: number[] = [];
  const localTables: boolean[] = [];
  let repeat: number | undefined;
  let offset = 13 + globalTableSize;
  const skipBlocks = () => {
    while (bytes[offset]) offset += 1 + bytes[offset];
    offset += 1;
  };
  while (offset < bytes.length && bytes[offset] !== 0x3b) {
    const marker = bytes[offset++];
    if (marker === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) delays.push(word(offset + 2) * 10);
      if (label === 0xff) {
        assert.equal(
          new TextDecoder().decode(bytes.subarray(offset + 1, offset + 12)),
          'NETSCAPE2.0',
        );
        repeat = word(offset + 14);
      }
      skipBlocks();
    } else {
      assert.equal(marker, 0x2c);
      assert.equal(word(offset + 4), word(6));
      assert.equal(word(offset + 6), word(8));
      const packed = bytes[offset + 8];
      localTables.push(Boolean(packed & 0x80));
      offset += 9;
      if (packed & 0x80) offset += 3 * 2 ** ((packed & 7) + 1);
      offset += 1; // LZW minimum code size
      skipBlocks();
    }
  }
  assert.equal(bytes[offset], 0x3b);
  assert.equal(offset, bytes.length - 1);
  return {
    width: word(6),
    height: word(8),
    palette,
    delays,
    repeat,
    localTables,
  };
}

describe('shared-palette GIF encoding', () => {
  it('writes 36 frames with one global palette, infinite looping and 1500 ms duration', async () => {
    const progress: number[] = [];
    const frames = Array.from({ length: 36 }, (_, i) => (i % 2 ? blue : red));
    const delays = generateGifFrameDelays(24, 36);
    const blob = await encodeOrbitGifFrames({
      frames,
      width: 1,
      height: 1,
      delays,
      onProgress: (done, total) => {
        assert.equal(total, 36);
        progress.push(done);
      },
    });
    assert.equal(blob.type, 'image/gif');
    const gif = inspectGif(new Uint8Array(await blob.arrayBuffer()));
    assert.equal(gif.width, 1);
    assert.equal(gif.height, 1);
    assert.deepEqual(gif.delays, delays);
    assert.equal(
      gif.delays.reduce((a, b) => a + b, 0),
      1500,
    );
    assert.equal(gif.repeat, 0);
    assert.deepEqual(gif.localTables, Array(36).fill(false));
    const colors = Array.from({ length: gif.palette.length / 3 }, (_, i) =>
      Array.from(gif.palette.subarray(i * 3, i * 3 + 3)),
    );
    assert.ok(colors.some(([r, g, b]) => r > 240 && g < 10 && b < 10));
    assert.ok(colors.some(([r, g, b]) => b > 240 && g < 10 && r < 10));
    assert.deepEqual(
      progress,
      Array.from({ length: 36 }, (_, i) => i + 1),
    );
  });

  it('encodes unaligned RGBA views identically to standalone buffers', async () => {
    const encode = (frame: Uint8Array) =>
      encodeOrbitGifFrames({
        frames: [frame],
        width: 1,
        height: 1,
        delays: [40],
      });
    const view = new Uint8Array([9, ...red, 8]).subarray(1, 5);
    assert.deepEqual(
      await (await encode(view)).arrayBuffer(),
      await (await encode(red)).arrayBuffer(),
    );
  });

  it('rejects invalid dimensions, delays and color counts', async () => {
    const options = { frames: [red], width: 1, height: 1, delays: [40] };
    for (const change of [
      { width: 0 },
      { width: 65536 },
      { height: 2 },
      { delays: [] },
      { delays: [41] },
      { maxColors: 257 },
    ]) {
      await assert.rejects(
        encodeOrbitGifFrames({ ...options, ...change }),
        RangeError,
      );
    }
  });
});

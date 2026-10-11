/** Preserve full RGB precision before reducing the animation to a shared palette. */
export function buildOrbitPalette(
  samples: Uint8Array,
  limit: number,
): number[][] {
  const histogram = new Map<number, number>();
  for (let i = 0; i < samples.length; i += 4) {
    const key = (samples[i] << 16) | (samples[i + 1] << 8) | samples[i + 2];
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const colors = [...histogram].map(([key, count]) => ({
    rgb: [key >>> 16, (key >>> 8) & 255, key & 255],
    count,
  }));
  const makeBox = (entries: typeof colors) => {
    const ranges = [0, 1, 2].map((channel) => {
      let min = 255,
        max = 0;
      for (const entry of entries) {
        min = Math.min(min, entry.rgb[channel]);
        max = Math.max(max, entry.rgb[channel]);
      }
      return max - min;
    });
    const axis = ranges.indexOf(Math.max(...ranges));
    const weight = entries.reduce((sum, entry) => sum + entry.count, 0);
    return { entries, axis, weight, score: ranges[axis] ** 2 * weight };
  };
  const boxes = [makeBox(colors)];
  while (boxes.length < limit) {
    let index = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (
        boxes[i].entries.length > 1 &&
        (index < 0 || boxes[i].score > boxes[index].score)
      )
        index = i;
    }
    if (index < 0) break;
    const box = boxes[index];
    box.entries.sort((a, b) => a.rgb[box.axis] - b.rgb[box.axis]);
    let weight = 0,
      split = 0;
    do {
      weight += box.entries[split++].count;
    } while (split < box.entries.length - 1 && weight < box.weight / 2);
    boxes.splice(
      index,
      1,
      makeBox(box.entries.slice(0, split)),
      makeBox(box.entries.slice(split)),
    );
  }
  return boxes.map(({ entries, weight }) =>
    [0, 1, 2].map((channel) =>
      Math.round(
        entries.reduce(
          (sum, entry) => sum + entry.rgb[channel] * entry.count,
          0,
        ) / weight,
      ),
    ),
  );
}

/** Exact RGB cache keys avoid merging neighboring gray shades into RGB565 bins. */
export function mapOrbitPalette(
  rgba: Uint8Array | Uint8ClampedArray,
  palette: number[][],
): Uint8Array {
  const indexed = new Uint8Array(rgba.length / 4);
  const cache = new Map<number, number>();
  for (let i = 0; i < indexed.length; i++) {
    const r = rgba[i * 4],
      g = rgba[i * 4 + 1],
      b = rgba[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let nearest = cache.get(key);
    if (nearest === undefined) {
      let distance = Infinity;
      nearest = 0;
      for (let p = 0; p < palette.length; p++) {
        const color = palette[p];
        const error =
          (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
        if (error < distance) {
          distance = error;
          nearest = p;
        }
        if (error === 0) break;
      }
      // Bound memory even for photographic or heavily colored input.
      if (cache.size < 65_536) cache.set(key, nearest);
    }
    indexed[i] = nearest;
  }
  return indexed;
}

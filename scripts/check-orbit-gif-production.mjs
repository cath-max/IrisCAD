import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Run after npm run build. Check emitted code and source-map module identities,
// not sourcesContent: ThreeScene's original source contains a removed DEV branch.
const roots = ['.output/public', '.output/server'];
const forbiddenCode =
  /DevOrbitGifExporter|withPausedOrbitPreview|Export orbit GIF|README GIF|iris-wastebasket-orbit|gifenc|sampleOrbitGifPixels/;
const forbiddenModule =
  /(?:DevOrbitGifExporter|orbitGifPreviewSession|orbitGifEncoding|orbitGifPalette|orbitGifState|exportOrbitGif|gifenc)/;
let codeFiles = 0;
let maps = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') await inspect(filename);
    } else if (/\.(?:m?js|cjs|html)$/.test(entry.name)) {
      const code = await readFile(filename, 'utf8');
      assert.ok(
        !forbiddenCode.test(code),
        `DEV GIF code leaked into ${filename}`,
      );
      codeFiles += 1;
    } else if (/\.map$/.test(entry.name)) {
      const map = JSON.parse(await readFile(filename, 'utf8'));
      for (const source of map.sources ?? []) {
        assert.ok(
          !forbiddenModule.test(source),
          `DEV GIF module ${source} leaked into ${filename}`,
        );
      }
      maps += 1;
    }
  }
}
for (const root of roots) await inspect(root);
assert.ok(codeFiles > 0, 'No production code found. Run npm run build first.');
console.log(
  `Orbit GIF production isolation passed: ${codeFiles} code/HTML files, ${maps} source maps; no DEV exporter or encoder modules.`,
);

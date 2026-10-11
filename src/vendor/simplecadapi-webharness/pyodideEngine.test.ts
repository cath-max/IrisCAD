import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const engineSource = readFileSync(
  new URL('./pyodideEngine.mjs', import.meta.url),
  'utf8',
);

test('browser CAD runtime does not load matplotlib', () => {
  assert.doesNotMatch(
    engineSource,
    /loadPackage\([^)]*matplotlib/,
    'Pyodide loadPackage must not restore the plotting dependency tree',
  );
  assert.match(
    engineSource,
    /loadPackage\(\['micropip', 'numpy'\]\)/,
    'Pyodide must keep the CAD runtime dependencies it still needs',
  );
});

test('browser CAD runtime falls back across versioned wheel sources', () => {
  assert.match(engineSource, /async def _install_with_fallback/);
  assert.match(engineSource, /for url in urls/);
  assert.match(engineSource, /All \{label\} wheel sources failed/);
});

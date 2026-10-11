/**
 * Shared SimpleCADAPI wheel + sidecar helpers for local IrisCAD setup.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CADAM_ROOT = path.resolve(HERE, '..', '..');
export const VENDOR_DEST = path.join(
  CADAM_ROOT,
  'public',
  'vendor',
  'simplecadapi',
);
const WHEELS_TS = path.join(CADAM_ROOT, 'src', 'worker', 'simpleCadWheels.ts');

const SIBLING_DIR_NAMES = [
  'iriscad-simplecadapi',
  'SimpleCADAPI-repo',
  'SimpleCADAPI',
  'my-simplecadapi',
  'simplecadapi',
];

export function run(command, cwd) {
  execSync(command, { cwd, stdio: 'inherit', shell: true });
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { force: false, simpleCadRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      out.force = true;
      continue;
    }
    if (arg.startsWith('--simplecadapi-root=')) {
      out.simpleCadRoot = arg.slice('--simplecadapi-root='.length);
      continue;
    }
    if (arg === '--simplecadapi-root') {
      out.simpleCadRoot = argv[i + 1];
      i += 1;
      continue;
    }
    // Recover `--simplecadapi -root=PATH` (space in the flag).
    if (arg === '--simplecadapi' && argv[i + 1]?.startsWith('-root=')) {
      console.warn(
        'Use --simplecadapi-root=<path> as one flag (no space). Recovering.',
      );
      out.simpleCadRoot = argv[i + 1].slice('-root='.length);
      i += 1;
      continue;
    }
    if (arg === '--simplecadapi' || arg.startsWith('--simplecadapi')) {
      throw new Error(
        `Unknown flag ${arg}. Use --simplecadapi-root=<path> (no space) ` +
          'or --simplecadapi-root <path>.',
      );
    }
  }
  return out;
}

export function resolveSimpleCadRoot(explicitPath) {
  const fromArg = explicitPath || process.env.SIMPLECADAPI_ROOT;
  if (fromArg) {
    const resolved = path.resolve(fromArg);
    if (!fs.existsSync(resolved)) {
      throw new Error(`SimpleCADAPI path does not exist: ${resolved}`);
    }
    return resolved;
  }

  const parent = path.resolve(CADAM_ROOT, '..');
  const hits = SIBLING_DIR_NAMES.map((name) => path.join(parent, name)).filter(
    (candidate) => fs.existsSync(candidate),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(
      `Multiple SimpleCADAPI checkouts found:\n  ${hits.join('\n  ')}\n` +
        'Pass --simplecadapi-root=<path> (no space).',
    );
  }

  throw new Error(
    'Could not find a SimpleCADAPI checkout next to CADAM. Clone it as a ' +
      'sibling (SimpleCADAPI-repo, SimpleCADAPI, or my-simplecadapi) or pass ' +
      '--simplecadapi-root=<path> (one flag, no space). ' +
      'You can also set SIMPLECADAPI_ROOT.',
  );
}

function newestWheel(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const matches = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.whl'))
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.name ?? null;
}

export function assertZipWheel(filePath, { minBytes }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing checked-in browser wheel: ${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  if (size < minBytes) {
    throw new Error(
      `${filePath} is ${size} bytes (expected >= ${minBytes}). ` +
        'Run `npm run setup:wheels -- --force`; a truncated download or ' +
        'HTML 404 may have been copied.',
    );
  }
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(
      `${path.basename(filePath)} is not a zip/wheel ` +
        `(got ${buf.toString('hex')}). Run ` +
        '`npm run setup:wheels -- --force` to replace it.',
    );
  }
}

export function validateCheckedInVendorWheels() {
  if (!fs.existsSync(WHEELS_TS)) {
    throw new Error(`Missing wheel manifest: ${WHEELS_TS}`);
  }
  const manifest = fs.readFileSync(WHEELS_TS, 'utf8');
  const ocpName = manifest.match(/SIMPLECADAPI_OCP_WHEEL\s*=\s*'([^']+)'/)?.[1];
  const packageName = manifest.match(
    /SIMPLECADAPI_PACKAGE_WHEEL\s*=\s*'([^']+)'/,
  )?.[1];
  if (!ocpName || !packageName) {
    throw new Error(`Could not read pinned wheel filenames from ${WHEELS_TS}.`);
  }
  assertZipWheel(path.join(VENDOR_DEST, ocpName), { minBytes: 1_000_000 });
  assertZipWheel(path.join(VENDOR_DEST, packageName), { minBytes: 50_000 });
  console.log(
    `[setup] checked existing browser wheels: ${packageName}, ${ocpName}`,
  );
  return { ocpWheel: ocpName, packageWheel: packageName };
}

export function ensureUv() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      'uv is not on PATH. Install: https://docs.astral.sh/uv/getting-started/installation/',
      { cause: error },
    );
  }
}

function runUv(args, cwd) {
  ensureUv();
  execFileSync('uv', args, { cwd, stdio: 'inherit' });
}

export function uvSync(simpleCadRoot) {
  console.log(`\n[setup] uv sync --frozen --group dev  (${simpleCadRoot})`);
  runUv(['sync', '--frozen', '--group', 'dev'], simpleCadRoot);
}

export function buildVendorWheels(simpleCadRoot) {
  console.log(`\n[setup] building wheels via webharness/test/setup-vendor.mjs`);
  run('node webharness/test/setup-vendor.mjs', simpleCadRoot);
}

export function syncWheelsToCadam(simpleCadRoot, { force = false } = {}) {
  const vendorDir = path.join(simpleCadRoot, 'webharness', 'test', 'vendor');
  const packageWheel = newestWheel(vendorDir, 'simplecadapi-');
  const ocpWheel = newestWheel(vendorDir, 'cadquery_ocp');
  const missing = !packageWheel || !ocpWheel;

  if (force || missing) {
    if (!force && missing) {
      console.log('[setup] vendor wheels missing; building…');
    }
    buildVendorWheels(simpleCadRoot);
  }

  const packageName = newestWheel(vendorDir, 'simplecadapi-');
  const ocpName = newestWheel(vendorDir, 'cadquery_ocp');
  if (!packageName || !ocpName) {
    throw new Error(
      `Expected simplecadapi-*.whl and cadquery_ocp*.whl in ${vendorDir}`,
    );
  }

  assertZipWheel(path.join(vendorDir, ocpName), { minBytes: 1_000_000 });
  assertZipWheel(path.join(vendorDir, packageName), { minBytes: 50_000 });

  fs.mkdirSync(VENDOR_DEST, { recursive: true });
  for (const name of fs.readdirSync(VENDOR_DEST)) {
    if (name.endsWith('.whl') && name !== packageName && name !== ocpName) {
      fs.unlinkSync(path.join(VENDOR_DEST, name));
    }
  }
  for (const name of [ocpName, packageName]) {
    const from = path.join(vendorDir, name);
    const to = path.join(VENDOR_DEST, name);
    fs.copyFileSync(from, to);
    console.log(`copied ${name} (${fs.statSync(to).size} bytes)`);
  }

  patchWheelConstants(ocpName, packageName);
  return { ocpWheel: ocpName, packageWheel: packageName };
}

function patchWheelConstants(ocpWheel, packageWheel) {
  if (!fs.existsSync(WHEELS_TS)) {
    throw new Error(`Missing ${WHEELS_TS}`);
  }
  const before = fs.readFileSync(WHEELS_TS, 'utf8');
  let next = before.replace(
    /export const SIMPLECADAPI_OCP_WHEEL =\s*'[^']+';/,
    `export const SIMPLECADAPI_OCP_WHEEL =\n  '${ocpWheel}';`,
  );
  next = next.replace(
    /export const SIMPLECADAPI_PACKAGE_WHEEL =\s*'[^']+';/,
    `export const SIMPLECADAPI_PACKAGE_WHEEL =\n  '${packageWheel}';`,
  );
  if (next === before) {
    if (
      before.includes(`'${ocpWheel}'`) &&
      before.includes(`'${packageWheel}'`)
    ) {
      console.log('simpleCadWheels.ts already matches copied wheel names.');
      return;
    }
    throw new Error(
      `Could not update wheel filenames in ${WHEELS_TS}. ` +
        'Expected SIMPLECADAPI_OCP_WHEEL / SIMPLECADAPI_PACKAGE_WHEEL exports.',
    );
  }
  fs.writeFileSync(WHEELS_TS, next);
  console.log(
    `updated src/worker/simpleCadWheels.ts → ${packageWheel}, ${ocpWheel}`,
  );
}

export function startSidecar(simpleCadRoot) {
  console.log(`\n[sidecar] http://127.0.0.1:8765  (${simpleCadRoot})`);
  runUv(
    [
      'run',
      '--frozen',
      'python',
      'scripts/serve_api_retrieval.py',
      '--host',
      '127.0.0.1',
      '--port',
      '8765',
    ],
    simpleCadRoot,
  );
}

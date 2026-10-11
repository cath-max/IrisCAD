#!/usr/bin/env node
/**
 * Populate CADAM `public/vendor/simplecadapi/` with Pyodide wheels.
 *
 * Usage (from CADAM root):
 *   node scripts/setup-simplecadapi-vendor.mjs
 *   node scripts/setup-simplecadapi-vendor.mjs --simplecadapi-root=D:/path/to/my-simplecadapi
 *   node scripts/setup-simplecadapi-vendor.mjs --simplecadapi-root D:/path/to/my-simplecadapi
 *   node scripts/setup-simplecadapi-vendor.mjs --force
 *
 * Also updates `src/worker/simpleCadWheels.ts` so the Worker URL matches
 * the copied filenames (avoids Vite serving index.html as a .whl).
 */

import {
  parseArgs,
  resolveSimpleCadRoot,
  syncWheelsToCadam,
  VENDOR_DEST,
} from './lib/simplecadapi-vendor.mjs';

const args = parseArgs();
const simpleCadRoot = resolveSimpleCadRoot(args.simpleCadRoot);
const wheels = syncWheelsToCadam(simpleCadRoot, { force: args.force });

console.log(`\nDone. Wheels are at ${VENDOR_DEST}`);
console.log('Dev server will serve them under /vendor/simplecadapi/');
console.log(`  OCP:     ${wheels.ocpWheel}`);
console.log(`  package: ${wheels.packageWheel}`);

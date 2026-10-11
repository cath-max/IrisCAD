#!/usr/bin/env node
/**
 * One-shot local bootstrap for IrisCAD + a sibling SimpleCADAPI checkout.
 *
 * Prepares dependencies and configuration without rebuilding the checked-in
 * browser wheels or starting long-running services.
 *
 * Does not start long-running processes (Supabase, sidecar, Vite).
 *
 * Usage (from IrisCAD root):
 *   npm run setup:local
 *   npm run setup:local -- --simplecadapi-root=D:/path/to/my-simplecadapi
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CADAM_ROOT,
  parseArgs,
  resolveSimpleCadRoot,
  run,
  uvSync,
  validateCheckedInVendorWheels,
} from './lib/simplecadapi-vendor.mjs';
import {
  ensureLocalEnvFile,
  isConfiguredValue,
  readLocalEnv,
} from './lib/local-env.mjs';

function checkEnvLocal() {
  const result = ensureLocalEnvFile(CADAM_ROOT);
  if (result.created) {
    console.log('\nCreated .env.local from .env.local.template.');
  } else if (result.addedNames.length) {
    console.log(
      `\nAdded missing template variables to .env.local: ${result.addedNames.join(', ')}`,
    );
  }
  const values = readLocalEnv(CADAM_ROOT);
  const problems = [];
  const aiKeys = [
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'ZENMUX_API_KEY',
  ];
  if (!aiKeys.some((name) => isConfiguredValue(values[name]))) {
    problems.push('configure at least one supported AI provider key');
  }
  for (const name of [
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL',
  ]) {
    if (!isConfiguredValue(values[name])) problems.push(`configure ${name}`);
  }
  if (problems.length) {
    console.log('\nBefore `npm run dev:local`, edit .env.local:');
    for (const line of problems) console.log(`  - ${line}`);
  } else {
    console.log(
      '.env.local external AI and embedding settings look configured.',
    );
  }
}

function ensureNpmInstall() {
  const nodeModules = path.join(CADAM_ROOT, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    console.log('node_modules already present; skipping npm install.');
    return;
  }
  console.log('\n[setup] npm ci --legacy-peer-deps');
  run('npm ci --legacy-peer-deps', CADAM_ROOT);
}

const args = parseArgs();
const simpleCadRoot = resolveSimpleCadRoot(args.simpleCadRoot);

console.log(`IrisCAD:      ${CADAM_ROOT}`);
console.log(`SimpleCADAPI: ${simpleCadRoot}`);

uvSync(simpleCadRoot);
validateCheckedInVendorWheels();
ensureNpmInstall();
checkEnvLocal();

console.log(`
Next:
  1. Fill the external AI + embedding placeholders in .env.local.
  2. Start the complete local stack:
     npm run dev:local -- --simplecadapi-root=${simpleCadRoot}
  3. Open http://localhost:3000/

Only rebuild browser wheels when changing SimpleCADAPI or OCP/WASM:
  npm run setup:wheels -- --simplecadapi-root=${simpleCadRoot}
`);

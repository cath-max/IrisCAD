#!/usr/bin/env node
/**
 * Start the complete IrisCAD local stack:
 *   Supabase (persistent Docker services) + retrieval sidecar + Vite.
 *
 * Supabase credentials are read with `supabase status -o env` and written to
 * .env.local without printing them. External AI and embedding credentials
 * remain user-managed in that same file.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  CADAM_ROOT,
  parseArgs,
  resolveSimpleCadRoot,
  validateCheckedInVendorWheels,
} from './lib/simplecadapi-vendor.mjs';
import {
  ensureLocalEnvFile,
  isConfiguredValue,
  loadLocalEnv,
  readLocalEnv,
  supabaseValuesFromStatus,
  writeLocalEnvValues,
} from './lib/local-env.mjs';

const args = parseArgs();
const simpleCadRoot = resolveSimpleCadRoot(args.simpleCadRoot);
const envResult = ensureLocalEnvFile(CADAM_ROOT);
if (envResult.created) {
  throw new Error(
    'Created .env.local from .env.local.template. Fill its external AI and ' +
      'embedding keys, then run `npm run dev:local` again.',
  );
}
if (envResult.addedNames.length) {
  console.warn(
    `Added missing template variables to .env.local: ${envResult.addedNames.join(', ')}`,
  );
}

function assertExternalConfiguration() {
  const values = readLocalEnv(CADAM_ROOT);
  const aiKeys = [
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'ZENMUX_API_KEY',
  ];
  const missing = [];
  if (!aiKeys.some((name) => isConfiguredValue(values[name]))) {
    missing.push('at least one supported AI provider key');
  }
  for (const name of [
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL',
  ]) {
    if (!isConfiguredValue(values[name])) missing.push(name);
  }
  if (missing.length) {
    throw new Error(
      `Configure the following in .env.local before starting:\n  - ${missing.join('\n  - ')}`,
    );
  }
}

function supabaseEntry() {
  const candidate = path.join(
    CADAM_ROOT,
    'node_modules',
    'supabase',
    'dist',
    'supabase.js',
  );
  if (!fs.existsSync(candidate)) {
    throw new Error(
      'Missing local Supabase CLI. Run `npm run setup:local` first.',
    );
  }
  return candidate;
}

function runSupabase(args, options = {}) {
  const result = spawnSync(process.execPath, [supabaseEntry(), ...args], {
    cwd: CADAM_ROOT,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `supabase ${args.join(' ')} failed with code ${result.status}.`,
    );
  }
  return result;
}

function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function spawnService(label, command, commandArgs, options = {}) {
  console.log(`[dev:local] starting ${label}`);
  const child = spawn(command, commandArgs, {
    cwd: CADAM_ROOT,
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    windowsHide: true,
    ...options,
  });
  child.on('error', (error) => {
    console.error(`[dev:local] ${label} failed to start:`, error);
  });
  return child;
}

validateCheckedInVendorWheels();
assertExternalConfiguration();
loadLocalEnv(CADAM_ROOT, { override: false });

console.log('[dev:local] starting or reusing local Supabase services');
runSupabase(['start'], { stdio: 'inherit' });
const status = runSupabase(['status', '-o', 'env']);
writeLocalEnvValues(CADAM_ROOT, supabaseValuesFromStatus(status.stdout));
loadLocalEnv(CADAM_ROOT, { override: true });
console.log('[dev:local] updated local Supabase settings in .env.local');

const sidecar = spawnService('retrieval sidecar', process.execPath, [
  path.join(CADAM_ROOT, 'scripts', 'run-sidecar.mjs'),
  `--simplecadapi-root=${simpleCadRoot}`,
]);
const vite = spawnService('Vite', process.execPath, [
  path.join(CADAM_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
]);
const children = [sidecar, vite];
let shuttingDown = false;

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stopProcessTree(child);
  console.log(
    '[dev:local] stopped sidecar and Vite. Supabase remains running; ' +
      'use `npx supabase stop` when needed.',
  );
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const [index, child] of children.entries()) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const label = index === 0 ? 'retrieval sidecar' : 'Vite';
    console.error(
      `[dev:local] ${label} exited${signal ? ` from ${signal}` : ` with code ${code ?? 1}`}.`,
    );
    shutdown(code ?? 1);
  });
}

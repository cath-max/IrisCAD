#!/usr/bin/env node

import { createReadStream, createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const MARKER_KINDS =
  'parameters|helper|part|assembly_setup|component|assembly_result';
const LEGACY_MARKER_RE = new RegExp(
  `^(\\s*#\\s*)cadam:(${MARKER_KINDS})(?=\\s|$)`,
  'gim',
);
const ANY_MARKER_RE = new RegExp(
  `^\\s*#\\s*(?:cadam|iriscad):(${MARKER_KINDS})(?:\\s+([a-z][a-z0-9_]*))?\\s*$`,
  'gim',
);
const PAGE_SIZE = 500;
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const selfTest = args.includes('--self-test');
const apply = args.includes('--apply');
const rollbackIndex = args.indexOf('--rollback');
const rollbackFile = rollbackIndex >= 0 ? args[rollbackIndex + 1] : null;

if (selfTest) {
  runSelfTest();
  process.exit(0);
}
if (apply && rollbackFile) {
  throw new Error('Choose either --apply or --rollback, not both.');
}
if (rollbackIndex >= 0 && !rollbackFile) {
  throw new Error('--rollback requires the path to an NDJSON backup file.');
}

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Load the project environment before running this script.',
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

if (rollbackFile) {
  await rollback(resolve(rollbackFile));
} else {
  await migrate({ apply });
}

async function migrate({ apply }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = resolve('migration-backups');
  const backupPath = resolve(
    backupDir,
    `cadam-to-iriscad-markers-${timestamp}.ndjson`,
  );
  let backupStream = null;
  if (apply) {
    await mkdir(backupDir, { recursive: true });
    backupStream = createWriteStream(backupPath, { encoding: 'utf8' });
  }

  const changedRows = [];
  let scanned = 0;
  let markerCount = 0;

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('messages')
      .select('id, conversation_id, parts, content')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      scanned += 1;
      const partsResult = migrateJson(row.parts);
      const contentResult = migrateJson(row.content);
      const replacements = partsResult.replacements + contentResult.replacements;
      if (!replacements) continue;

      markerCount += replacements;
      const change = {
        id: row.id,
        conversation_id: row.conversation_id,
        original: { parts: row.parts, content: row.content },
        migrated: {
          parts: partsResult.value,
          content: contentResult.value,
        },
        replacements,
      };
      changedRows.push(change);
      backupStream?.write(
        `${JSON.stringify({
          id: change.id,
          conversation_id: change.conversation_id,
          parts: change.original.parts,
          content: change.original.content,
        })}\n`,
      );
    }

    if (data.length < PAGE_SIZE) break;
  }

  if (backupStream) await closeStream(backupStream);

  console.log(
    `${apply ? 'Apply' : 'Dry run'}: scanned ${scanned} messages; ` +
      `${changedRows.length} rows and ${markerCount} marker lines require migration.`,
  );

  if (!apply) {
    console.log('No database rows were changed. Re-run with --apply to migrate.');
    return;
  }

  console.log(`Backup written before updates: ${backupPath}`);
  let updated = 0;
  await runPool(changedRows, CONCURRENCY, async (change) => {
    const { error } = await supabase
      .from('messages')
      .update(change.migrated)
      .eq('id', change.id);
    if (error) throw new Error(`Failed to update message ${change.id}: ${error.message}`);
    updated += 1;
    if (updated % 100 === 0) console.log(`Updated ${updated}/${changedRows.length} rows…`);
  });

  console.log(
    `Migration complete: updated ${updated} rows and ${markerCount} marker lines.`,
  );
  console.log(`Rollback command: npm run migrate:iriscad-markers -- --rollback "${backupPath}"`);
}

async function rollback(path) {
  const records = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim()) records.push(JSON.parse(line));
  }

  console.log(`Restoring ${records.length} messages from ${path}…`);
  let restored = 0;
  await runPool(records, CONCURRENCY, async (record) => {
    const { error } = await supabase
      .from('messages')
      .update({ parts: record.parts, content: record.content })
      .eq('id', record.id);
    if (error) throw new Error(`Failed to restore message ${record.id}: ${error.message}`);
    restored += 1;
    if (restored % 100 === 0) console.log(`Restored ${restored}/${records.length} rows…`);
  });
  console.log(`Rollback complete: restored ${restored} messages.`);
}

function migrateJson(value) {
  if (typeof value === 'string') return migrateString(value);
  if (Array.isArray(value)) {
    let replacements = 0;
    const migrated = value.map((item) => {
      const result = migrateJson(item);
      replacements += result.replacements;
      return result.value;
    });
    return { value: replacements ? migrated : value, replacements };
  }
  if (value && typeof value === 'object') {
    let replacements = 0;
    const migrated = {};
    for (const [key, item] of Object.entries(value)) {
      const result = migrateJson(item);
      migrated[key] = result.value;
      replacements += result.replacements;
    }
    return { value: replacements ? migrated : value, replacements };
  }
  return { value, replacements: 0 };
}

function migrateString(value) {
  const before = markerSequence(value);
  let replacements = 0;
  const migrated = value.replace(LEGACY_MARKER_RE, (_match, prefix, kind) => {
    replacements += 1;
    return `${prefix}iriscad:${kind}`;
  });
  if (!replacements) return { value, replacements: 0 };

  const after = markerSequence(migrated);
  if (before.length !== after.length || before.some((item, index) => item !== after[index])) {
    throw new Error('Marker structure changed during migration; refusing to continue.');
  }
  if (LEGACY_MARKER_RE.test(migrated)) {
    LEGACY_MARKER_RE.lastIndex = 0;
    throw new Error('A legacy marker remained after migration; refusing to continue.');
  }
  LEGACY_MARKER_RE.lastIndex = 0;
  return { value: migrated, replacements };
}

function markerSequence(value) {
  const sequence = [];
  ANY_MARKER_RE.lastIndex = 0;
  for (const match of value.matchAll(ANY_MARKER_RE)) {
    sequence.push(`${match[1]}/${match[2] ?? match[1]}`);
  }
  ANY_MARKER_RE.lastIndex = 0;
  return sequence;
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function closeStream(stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.on('error', rejectPromise);
    stream.end(() => resolvePromise());
  });
}

function runSelfTest() {
  const source = [
    'import simplecadapi as scad',
    '# cadam:parameters',
    'size = 20',
    '# cadam:part base_part',
    'base_part = scad.make_box(size, size, size)',
    '# cadam:assembly_result',
    'result = base_part',
  ].join('\n');
  const nested = {
    source,
    untouched: '# cadamish:part should_not_change',
    values: [null, 3],
  };
  const result = migrateJson(nested);

  assert.equal(result.replacements, 3);
  assert.match(result.value.source, /^# iriscad:parameters$/m);
  assert.match(result.value.source, /^# iriscad:part base_part$/m);
  assert.match(result.value.source, /^# iriscad:assembly_result$/m);
  assert.equal(result.value.untouched, nested.untouched);
  assert.deepEqual(markerSequence(source), markerSequence(result.value.source));
  console.log('Self-test passed.');
}

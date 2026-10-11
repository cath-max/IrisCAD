#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const TABLES = [
  'conversations',
  'images',
  'iris_credit_accounts',
  'iris_credit_transactions',
  'meshes',
  'messages',
  'previews',
  'profiles',
  'prompts',
];
const PAGE_SIZE = 500;

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Load .env.local before running.',
  );
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = resolve('database-backups', `public-${timestamp}`);
await mkdir(backupDir, { recursive: true });

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const manifest = {
  createdAt: new Date().toISOString(),
  supabaseUrl,
  scope: 'public table rows exposed by the generated Database type',
  excludes: ['auth schema', 'storage objects', 'database functions and schema DDL'],
  tables: {},
};

for (const table of TABLES) {
  const filePath = resolve(backupDir, `${table}.ndjson`);
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  let rows = 0;
  let missing = false;

  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .range(from, from + PAGE_SIZE - 1);
      if (error?.code === 'PGRST205') {
        missing = true;
        break;
      }
      if (error) throw error;
      for (const row of data ?? []) {
        if (!stream.write(`${JSON.stringify(row)}\n`)) {
          await new Promise((resolveDrain) => stream.once('drain', resolveDrain));
        }
        rows += 1;
      }
      if (!data || data.length < PAGE_SIZE) break;
    }
  } finally {
    await new Promise((resolveEnd, rejectEnd) => {
      stream.on('error', rejectEnd);
      stream.end(resolveEnd);
    });
  }

  manifest.tables[table] = missing
    ? { status: 'not present in API schema', rows: 0 }
    : { status: 'exported', rows, file: `${table}.ndjson` };
  console.log(`${table}: ${missing ? 'not present' : `${rows} rows`}`);
}

await writeFile(
  resolve(backupDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
console.log(`Backup complete: ${backupDir}`);

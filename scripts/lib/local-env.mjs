import fs from 'node:fs';
import path from 'node:path';

const ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const PLACEHOLDER_RE = /<[^>]+>|\bTest\b|your[-_ ]?(?:api[-_ ]?)?key/i;

function unquote(value) {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) {
    return value.replace(/\s+#.*$/, '').trim();
  }
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export function parseEnvText(text) {
  const values = {};
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(ASSIGNMENT_RE);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

export function isConfiguredValue(value) {
  return Boolean(value?.trim()) && !PLACEHOLDER_RE.test(value.trim());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteEnvValue(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

export function upsertEnvValues(text, values) {
  const newline = text.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  const endedWithNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  if (endedWithNewline && lines.at(-1) === '') lines.pop();
  for (const [name, value] of Object.entries(values)) {
    const assignment = `${name}=${quoteEnvValue(value)}`;
    const pattern = new RegExp(
      `^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=`,
    );
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) {
      lines[index] = assignment;
    } else {
      lines.push(assignment);
    }
  }
  if (!lines.length) return '';
  return `${lines.join(newline)}${endedWithNewline ? newline : ''}`;
}

export function mergeMissingTemplateValues(text, templateText) {
  const current = parseEnvText(text);
  const template = parseEnvText(templateText);
  const missing = Object.fromEntries(
    Object.entries(template).filter(([name]) => !(name in current)),
  );
  return {
    text: upsertEnvValues(text, missing),
    addedNames: Object.keys(missing),
  };
}

export function ensureLocalEnvFile(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  const templatePath = path.join(projectRoot, '.env.local.template');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Missing environment template: ${templatePath}`);
  }
  const templateText = fs.readFileSync(templatePath, 'utf8');
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(templatePath, envPath);
    return { envPath, created: true, addedNames: [] };
  }
  const current = fs.readFileSync(envPath, 'utf8');
  const merged = mergeMissingTemplateValues(current, templateText);
  if (merged.addedNames.length) fs.writeFileSync(envPath, merged.text);
  return { envPath, created: false, addedNames: merged.addedNames };
}

export function readLocalEnv(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  if (!fs.existsSync(envPath)) return {};
  return parseEnvText(fs.readFileSync(envPath, 'utf8'));
}

export function loadLocalEnv(projectRoot, { override = false } = {}) {
  const values = readLocalEnv(projectRoot);
  for (const [name, value] of Object.entries(values)) {
    if (override || process.env[name] === undefined) process.env[name] = value;
  }
  return values;
}

export function writeLocalEnvValues(projectRoot, values) {
  const { envPath } = ensureLocalEnvFile(projectRoot);
  const before = fs.readFileSync(envPath, 'utf8');
  fs.writeFileSync(envPath, upsertEnvValues(before, values));
}

function firstConfigured(values, names) {
  for (const name of names) {
    if (isConfiguredValue(values[name])) return values[name];
  }
  return '';
}

export function supabaseValuesFromStatus(text) {
  const values = parseEnvText(text);
  const url = firstConfigured(values, ['API_URL', 'SUPABASE_URL']);
  const anon = firstConfigured(values, [
    'ANON_KEY',
    'PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY',
  ]);
  const service = firstConfigured(values, [
    'SERVICE_ROLE_KEY',
    'SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  if (!url || !anon || !service) {
    throw new Error(
      'Could not read API_URL, ANON_KEY/PUBLISHABLE_KEY, and ' +
        'SERVICE_ROLE_KEY/SECRET_KEY from `supabase status -o env`.',
    );
  }
  return {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
  };
}

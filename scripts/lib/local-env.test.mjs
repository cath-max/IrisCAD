import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isConfiguredValue,
  mergeMissingTemplateValues,
  parseEnvText,
  supabaseValuesFromStatus,
  upsertEnvValues,
} from './local-env.mjs';

test('parses quoted and exported dotenv assignments', () => {
  assert.deepEqual(
    parseEnvText(`A="one"\nexport B='two'\nC=three # comment\n# D=no\n`),
    { A: 'one', B: 'two', C: 'three' },
  );
});

test('upserts values without exposing or duplicating existing keys', () => {
  const result = upsertEnvValues('A="old"\nB="keep"\n', {
    A: 'new',
    C: 'added',
  });
  assert.deepEqual(parseEnvText(result), {
    A: 'new',
    B: 'keep',
    C: 'added',
  });
});

test('adds only assignments missing from an existing local env', () => {
  const result = mergeMissingTemplateValues(
    'A="real"\n',
    'A="placeholder"\nB="new placeholder"\n',
  );
  assert.deepEqual(result.addedNames, ['B']);
  assert.deepEqual(parseEnvText(result.text), {
    A: 'real',
    B: 'new placeholder',
  });
});

test('supports legacy CR-only dotenv files without changing existing values', () => {
  const original = 'A="real-secret"\rB="keep-me"\r';
  assert.deepEqual(parseEnvText(original), {
    A: 'real-secret',
    B: 'keep-me',
  });
  const result = mergeMissingTemplateValues(
    original,
    'A="placeholder"\nB="placeholder"\nC="new placeholder"\n',
  );
  assert.deepEqual(result.addedNames, ['C']);
  assert.deepEqual(parseEnvText(result.text), {
    A: 'real-secret',
    B: 'keep-me',
    C: 'new placeholder',
  });
  assert.equal(result.text.includes('\n'), false);
});

test('upserts one CR-only assignment without consuming adjacent lines', () => {
  const result = upsertEnvValues('A="one"\rB="two"\rC="three"\r', {
    B: 'updated',
  });
  assert.deepEqual(parseEnvText(result), {
    A: 'one',
    B: 'updated',
    C: 'three',
  });
});

test('recognizes placeholders and real values', () => {
  assert.equal(isConfiguredValue('<Your API key>'), false);
  assert.equal(isConfiguredValue('Test Anthropic API Key'), false);
  assert.equal(isConfiguredValue('sk-real-value'), true);
});

test('maps legacy Supabase status env names', () => {
  assert.deepEqual(
    supabaseValuesFromStatus(
      'API_URL="http://127.0.0.1:54321"\nANON_KEY="anon"\nSERVICE_ROLE_KEY="service"\n',
    ),
    {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
    },
  );
});

test('maps current Supabase publishable and secret key names', () => {
  assert.deepEqual(
    supabaseValuesFromStatus(
      'API_URL="http://127.0.0.1:54321"\nPUBLISHABLE_KEY="publishable"\nSECRET_KEY="secret"\n',
    ),
    {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'publishable',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    },
  );
});

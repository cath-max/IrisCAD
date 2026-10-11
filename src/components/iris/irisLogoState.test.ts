import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IRIS_ACTIVE_LOGO,
  IRIS_STATIC_LOGO,
  resolveIrisLogoAsset,
} from './irisLogoState.ts';

test('uses the animated logo only while the agent is active', () => {
  assert.equal(IRIS_STATIC_LOGO, 'iris-logo-256.webp');
  assert.equal(IRIS_ACTIVE_LOGO, 'iris-agent-active.webp');
  assert.equal(resolveIrisLogoAsset(false, false), IRIS_STATIC_LOGO);
  assert.equal(resolveIrisLogoAsset(true, false), IRIS_ACTIVE_LOGO);
});

test('reduced motion always uses the static logo', () => {
  assert.equal(resolveIrisLogoAsset(false, true), IRIS_STATIC_LOGO);
  assert.equal(resolveIrisLogoAsset(true, true), IRIS_STATIC_LOGO);
});

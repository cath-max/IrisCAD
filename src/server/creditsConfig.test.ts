import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { areIrisCreditsEnabled } from './creditsConfig.ts';

describe('Iris Credits configuration', () => {
  it('enforces credits when the variable is missing in production', () => {
    assert.equal(areIrisCreditsEnabled('', 'production'), true);
  });

  it('enforces credits when explicitly enabled', () => {
    assert.equal(areIrisCreditsEnabled('true', 'local'), true);
  });

  it('bypasses credits only when explicitly disabled', () => {
    assert.equal(areIrisCreditsEnabled(' FALSE ', 'production'), false);
  });

  it('bypasses credits by default in the local environment', () => {
    assert.equal(areIrisCreditsEnabled('', 'local'), false);
  });
});

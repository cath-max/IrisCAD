import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeAssemblySectionRequest } from './assemblySectionExecution.mjs';

const success = { ok: true, result_type: 'Assembly', assembly: { components: [] } };
const failure = { ok: false, result_type: null, assembly: null };
const request = { code: 'full source', sessionId: 's1', previousArtifactVersion: 'v1', nextArtifactVersion: 'v2', sections: [{ kind: 'parameters', id: 'parameters' }] };

function engine({ partial = success, full = success, inspection = { ok: true } } = {}) {
  const calls = [];
  return {
    calls,
    async runAssemblySections() { calls.push('partial'); return partial; },
    async runCode() { calls.push('full'); return full; },
    async inspectAssemblyRenderState() { calls.push('inspect'); return inspection; },
    async resetSession() { calls.push('reset'); },
  };
}

describe('Assembly section Worker transaction', () => {
  it('uses complete execution for a version mismatch or missing session baseline', async () => {
    const fake = engine();
    const baselines = new Map();
    const result = await executeAssemblySectionRequest({ engine: fake, baselines, data: request });
    assert.equal(result.execution_mode, 'full');
    assert.equal(result.fallback_reason, 'worker_baseline_mismatch');
    assert.deepEqual(fake.calls, ['full']);
    assert.equal(baselines.get('s1'), 'v2');
  });

  it('commits a partial result only after Assembly inspection succeeds', async () => {
    const fake = engine();
    const baselines = new Map([['s1', 'v1']]);
    const result = await executeAssemblySectionRequest({ engine: fake, baselines, data: request });
    assert.equal(result.execution_mode, 'partial');
    assert.deepEqual(fake.calls, ['partial', 'inspect']);
    assert.equal(baselines.get('s1'), 'v2');
  });

  it('cleans the mixed namespace then completes a full fallback after partial failure', async () => {
    const fake = engine({ partial: failure });
    const baselines = new Map([['s1', 'v1']]);
    const result = await executeAssemblySectionRequest({ engine: fake, baselines, data: request });
    assert.equal(result.execution_mode, 'partial_then_full_fallback');
    assert.equal(result.partial_failure_detail, 'Partial section execution failed.');
    assert.deepEqual(fake.calls, ['partial', 'reset', 'full']);
    assert.equal(baselines.get('s1'), 'v2');
  });

  it('drops the baseline and cleans again when both partial and full paths fail', async () => {
    const fake = engine({ partial: failure, full: failure });
    const baselines = new Map([['s1', 'v1']]);
    const result = await executeAssemblySectionRequest({ engine: fake, baselines, data: request });
    assert.equal(result.ok, false);
    assert.deepEqual(fake.calls, ['partial', 'reset', 'full', 'reset']);
    assert.equal(baselines.has('s1'), false);
  });

  it('advances the baseline across serialized rapid parameter requests', async () => {
    const fake = engine();
    const baselines = new Map([['s1', 'v1']]);
    await executeAssemblySectionRequest({ engine: fake, baselines, data: request });
    await executeAssemblySectionRequest({ engine: fake, baselines, data: { ...request, previousArtifactVersion: 'v2', nextArtifactVersion: 'v3' } });
    assert.deepEqual(fake.calls, ['partial', 'inspect', 'partial', 'inspect']);
    assert.equal(baselines.get('s1'), 'v3');
  });
});

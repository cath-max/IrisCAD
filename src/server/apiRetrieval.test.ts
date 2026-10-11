import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppUIMessage } from '@shared/chatAi';
import {
  fetchApiPromptSlice,
  findLatestBuildErrorGuidance,
} from './apiRetrieval.ts';

const guidance = {
  operation: 'union_rsolid',
  what_happened: 'The solids do not intersect.',
  possible_causes: [],
  how_to_fix: ['Move the solids so they overlap.'],
  technical_details: null,
  signature: null,
  documentation_hint: null,
};

function assistantWithOutput(
  id: string,
  output: Record<string, unknown>,
): AppUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-build_parametric_model',
        toolCallId: `tool-${id}`,
        state: 'output-available',
        input: {
          title: 'Fixture',
          version: 'v1',
          code: 'import simplecadapi as scad\nresult = scad.make_box_rsolid(1, 1, 1)',
          artifact_kind: 'model',
          model_summary: 'A box.',
        },
        output,
      },
    ],
  } as AppUIMessage;
}

describe('current retrieval ErrorGuidance', () => {
  it('does not reuse an older failure after a later successful mutation', () => {
    const branch = [
      assistantWithOutput('failed', {
        status: 'error',
        message: 'failed',
        errorGuidance: guidance,
      }),
      assistantWithOutput('success', {
        status: 'success',
        message: 'ok',
        artifact_kind: 'model',
        result_type: 'Solid',
      }),
    ];
    assert.equal(findLatestBuildErrorGuidance(branch), null);
  });

  it('returns guidance from the newest failed mutation', () => {
    const branch = [
      assistantWithOutput('failed', {
        status: 'error',
        message: 'failed',
        errorGuidance: guidance,
      }),
    ];
    assert.deepEqual(findLatestBuildErrorGuidance(branch), guidance);
  });
});

function sidecarResponse(
  payload: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('retrieval fallback order', () => {
  it('retries BM25-only after hybrid retrieval fails', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      if (requestBodies.length === 1) {
        return sidecarResponse(
          { ok: false, error: 'embedding unavailable' },
          502,
        );
      }
      return sidecarResponse({
        ok: true,
        mode: 'hybrid',
        markdown: '# BM25 slice',
        hit_ids: ['radial_pattern_rsolidlist'],
        reasons: ['fused'],
      });
    };

    try {
      const slice = await fetchApiPromptSlice({
        query: 'rectangular holes repeated around a circular wall',
      });

      assert.equal(slice.usedCoreFallback, false);
      assert.deepEqual(slice.hitIds, ['radial_pattern_rsolidlist']);
      assert.equal(requestBodies.length, 2);
      assert.equal(requestBodies[0].use_vector, undefined);
      assert.equal(requestBodies[1].use_vector, false);
      assert.equal(requestBodies[1].core_only, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses core-only only when hybrid and BM25 both fail', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      if (requestBodies.length < 3) {
        return sidecarResponse({ ok: false, error: 'retrieve failed' }, 502);
      }
      return sidecarResponse({
        ok: true,
        mode: 'core_only',
        markdown: '# Core slice',
        hit_ids: ['cut_rsolid'],
        reasons: ['core'],
      });
    };

    try {
      const slice = await fetchApiPromptSlice({ query: 'perforated basket' });

      assert.equal(slice.usedCoreFallback, true);
      assert.deepEqual(slice.hitIds, ['cut_rsolid']);
      assert.equal(requestBodies.length, 3);
      assert.equal(requestBodies[1].use_vector, false);
      assert.equal(requestBodies[2].core_only, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

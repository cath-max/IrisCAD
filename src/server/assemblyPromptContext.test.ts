import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppUIMessage } from '@shared/chatAi';
import { shouldInjectAssemblyV1Reference } from './assemblyPromptContext';

function message(value: Record<string, unknown>): AppUIMessage {
  return value as unknown as AppUIMessage;
}

describe('Assembly V1 fixed reference injection', () => {
  it('injects for an explicit first-generation Assembly request', () => {
    assert.equal(
      shouldInjectAssemblyV1Reference([
        message({
          role: 'user',
          parts: [{ type: 'text', text: 'Build a detachable assembly.' }],
        }),
      ]),
      true,
    );
  });

  it('does not inject for an ordinary single-part request', () => {
    assert.equal(
      shouldInjectAssemblyV1Reference([
        message({
          role: 'user',
          parts: [{ type: 'text', text: 'Make one solid bracket.' }],
        }),
      ]),
      false,
    );
  });

  it('injects on a later revision after an Assembly artifact was produced', () => {
    assert.equal(
      shouldInjectAssemblyV1Reference([
        message({
          role: 'assistant',
          parts: [
            {
              type: 'tool-build_parametric_model',
              state: 'output-available',
              input: {
                title: 'fixture',
                version: 'v1',
                code: 'result = assembly',
                artifact_kind: 'assembly',
              },
            },
          ],
        }),
        message({
          role: 'user',
          parts: [{ type: 'text', text: 'Raise the gear by 5 mm.' }],
        }),
      ]),
      true,
    );
  });
});

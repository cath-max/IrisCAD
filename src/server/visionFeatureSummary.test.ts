import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppUIMessage } from '@shared/chatAi';
import {
  collectBranchReferenceImages,
  findCurrentUserReferenceImages,
  findLatestReferenceFeatureSummary,
} from './visionFeatureSummary.ts';

function user(parts: AppUIMessage['parts']): AppUIMessage {
  return { id: crypto.randomUUID(), role: 'user', parts };
}

function assistant(parts: AppUIMessage['parts']): AppUIMessage {
  return { id: crypto.randomUUID(), role: 'assistant', parts };
}

const image = (url: string) => ({
  type: 'file' as const,
  mediaType: 'image/png',
  url,
  filename: 'reference.png',
});

describe('reference image summary reuse', () => {
  it('recognizes images only on the current user turn', () => {
    const messages = [
      user([image('data:image/png;base64,old')]),
      user([{ type: 'text', text: 'make the bore wider' }]),
    ];
    assert.equal(findCurrentUserReferenceImages(messages), null);
  });

  it('combines all distinct branch images when a new image is supplied', () => {
    const messages = [
      user([image('data:image/png;base64,first')]),
      assistant([]),
      user([
        image('data:image/png;base64,first'),
        image('data:image/png;base64,new'),
      ]),
    ];
    assert.deepEqual(collectBranchReferenceImages(messages), [
      { mediaType: 'image/png', dataUrl: 'data:image/png;base64,first' },
      { mediaType: 'image/png', dataUrl: 'data:image/png;base64,new' },
    ]);
  });

  it('reuses the latest persisted summary for a text-only revision', () => {
    const messages = [
      user([image('data:image/png;base64,first')]),
      assistant([
        {
          type: 'data-reference-features',
          data: { summary: 'Overall:\nA round plate.', modelId: 'gemini' },
        },
      ]),
      user([{ type: 'text', text: 'make it thinner' }]),
    ];
    assert.equal(
      findLatestReferenceFeatureSummary(messages),
      'Overall:\nA round plate.',
    );
  });
});

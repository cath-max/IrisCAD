import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppUIMessage } from './chatAi.ts';
import {
  activeMessageBranch,
  resolveLatestParametricSeed,
  type SeedHistoryMessage,
} from './parametricModelSeed.ts';

function message({
  id,
  role,
  parent,
  parts,
}: {
  id: string;
  role: 'user' | 'assistant';
  parent: string | null;
  parts: AppUIMessage['parts'];
}): SeedHistoryMessage {
  return { id, role, parent_message_id: parent, parts, metadata: {} };
}

describe('parametric model seeds', () => {
  it('copies only the selected active branch', () => {
    const root = message({
      id: 'root',
      role: 'user',
      parent: null,
      parts: [{ type: 'text', text: 'make a part' }],
    });
    const selected = message({
      id: 'selected',
      role: 'assistant',
      parent: 'root',
      parts: [],
    });
    const sibling = message({
      id: 'sibling',
      role: 'assistant',
      parent: 'root',
      parts: [],
    });

    assert.deepEqual(
      activeMessageBranch([root, sibling, selected], 'selected').map(
        (item) => item.id,
      ),
      ['root', 'selected'],
    );
  });

  it('turns the latest successful full build into a clean seed', () => {
    const build = message({
      id: 'build-message',
      role: 'assistant',
      parent: null,
      parts: [
        {
          type: 'tool-build_parametric_model',
          toolCallId: 'build-tool',
          state: 'output-available',
          input: {
            title: 'Box',
            version: 'v1',
            artifact_kind: 'model',
            code: 'import simplecadapi as scad\nsize = 10 # [5:1:20]\nresult = scad.make_box_rsolid(size, size, size)',
            model_summary: 'A 10 mm box.',
          },
          output: {
            status: 'success',
            message: 'ok',
            artifact_kind: 'model',
            result_type: 'Solid',
            inspection: {
              views: ['ISO', 'FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'BOTTOM'],
              imageAttached: true,
            },
          },
        },
      ],
    });

    const seed = resolveLatestParametricSeed([build]);
    assert.equal(seed?.artifact.title, 'Box');
    assert.equal(seed?.sourceModelRevision, 'build-message:build-tool');
    assert.ok(seed?.parameters.some((parameter) => parameter.name === 'size'));
    assert.equal(seed?.output.inspection?.imageAttached, false);
  });
});

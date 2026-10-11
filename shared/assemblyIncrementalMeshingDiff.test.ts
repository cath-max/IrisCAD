import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssemblyPlacement } from './assemblyContract.ts';
import {
  buildAssemblyRenderSnapshot,
  buildAssemblySuccessfulArtifactVersion,
  classifyAssemblyRenderChanges,
  type InspectedAssemblyRenderState,
} from './assemblyIncrementalMeshingDiff.ts';

const identity: AssemblyPlacement = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, 1, 0],
  z_axis: [0, 0, 1],
};

const moved = (x: number): AssemblyPlacement => ({
  ...identity,
  origin: [x, 0, 0],
});
function snapshot(
  version: string,
  parts: string[],
  components: Array<[string, string, AssemblyPlacement]>,
) {
  const inspection: InspectedAssemblyRenderState = {
    ok: true,
    parts: parts.map((part_id) => ({ part_id })),
    components: components.map(([component_id, part_id, placement]) => ({
      component_id,
      part_id,
      placement,
    })),
  };
  return buildAssemblyRenderSnapshot({
    successful_artifact_version: version,
    inspection,
  });
}

describe('Assembly runtime change classification', () => {
  it('separates unchanged, placement-only, changed, added, and removed components', () => {
    const previous = snapshot(
      'v1',
      ['frame', 'saddle', 'removed_part'],
      [
        ['frame_component', 'frame', identity],
        ['saddle_component', 'saddle', identity],
        ['old_component', 'removed_part', identity],
      ],
    );
    const current = snapshot(
      'v2',
      ['frame', 'saddle', 'new_part'],
      [
        ['frame_component', 'frame', moved(10)],
        ['saddle_component', 'saddle', identity],
        ['new_component', 'new_part', identity],
      ],
    );
    const result = classifyAssemblyRenderChanges({
      previous,
      current,
      dirty_part_ids: ['saddle', 'new_part'],
    });
    assert.deepEqual(
      Object.fromEntries(
        result.components.map((item) => [item.component_id, item.kind]),
      ),
      {
        frame_component: 'placement_only',
        saddle_component: 'geometry_changed',
        new_component: 'added',
        old_component: 'removed',
      },
    );
    assert.deepEqual(result.part_ids_to_mesh, ['saddle', 'new_part']);
  });

  it('meshes one changed shared Part once and marks every instance changed', () => {
    const previous = snapshot(
      'v1',
      ['gear'],
      [
        ['left_gear', 'gear', moved(-5)],
        ['right_gear', 'gear', moved(5)],
      ],
    );
    const current = snapshot(
      'v2',
      ['gear'],
      [
        ['left_gear', 'gear', moved(-5)],
        ['right_gear', 'gear', moved(5)],
      ],
    );
    const result = classifyAssemblyRenderChanges({
      previous,
      current,
      dirty_part_ids: ['gear'],
    });
    assert.deepEqual(result.part_ids_to_mesh, ['gear']);
    assert.deepEqual(
      result.components.map((item) => item.kind),
      ['geometry_changed', 'geometry_changed'],
    );
  });

  it('does not mesh a newly added instance of an already cached Part', () => {
    const previous = snapshot('v1', ['gear'], [['left', 'gear', identity]]);
    const current = snapshot(
      'v2',
      ['gear'],
      [
        ['left', 'gear', identity],
        ['right', 'gear', moved(20)],
      ],
    );
    const result = classifyAssemblyRenderChanges({
      previous,
      current,
      dirty_part_ids: [],
    });
    assert.deepEqual(result.part_ids_to_mesh, []);
    assert.equal(result.components[1].kind, 'added');
  });

  it('meshes every statically dirty Part once', () => {
    const previous = snapshot(
      'v1',
      ['frame', 'saddle', 'wheel'],
      [
        ['frame', 'frame', identity],
        ['saddle', 'saddle', identity],
        ['wheel', 'wheel', identity],
      ],
    );
    const current = snapshot(
      'v2',
      ['frame', 'saddle', 'wheel'],
      previous.components.map((item) => [
        item.component_id,
        item.part_id,
        item.placement,
      ]),
    );
    const result = classifyAssemblyRenderChanges({
      previous,
      current,
      dirty_part_ids: ['frame', 'saddle'],
    });
    assert.deepEqual(result.part_ids_to_mesh, ['frame', 'saddle']);
  });

  it('binds cache state to both history revision and exact successful source', () => {
    const first = buildAssemblySuccessfulArtifactVersion({
      model_revision: 'message-1:tool-1',
      source_code: 'result = first',
    });
    assert.equal(
      first,
      buildAssemblySuccessfulArtifactVersion({
        model_revision: 'message-1:tool-1',
        source_code: 'result = first',
      }),
    );
    assert.notEqual(
      first,
      buildAssemblySuccessfulArtifactVersion({
        model_revision: 'message-1:tool-1',
        source_code: 'result = second',
      }),
    );
  });
});

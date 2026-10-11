import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Mesh } from 'three';
import type { AssemblyPlacement } from '../../shared/assemblyContract.ts';
import { buildAssemblyRenderSnapshot } from '../../shared/assemblyIncrementalMeshingDiff.ts';
import type { RenderAssemblyPartMeshesResult } from '../worker/simpleCadToolWorker.ts';
import {
  buildAssemblyIncrementalMeshingStats,
  SimpleCadAssemblyIncrementalPreview,
} from './simpleCadAssemblyIncrementalPreview.ts';

const identity: AssemblyPlacement = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, 1, 0],
  z_axis: [0, 0, 1],
};
function snapshot(
  version: string,
  components: Array<[string, AssemblyPlacement]>,
) {
  return buildAssemblyRenderSnapshot({
    successful_artifact_version: version,
    inspection: {
      ok: true,
      parts: [{ part_id: 'gear' }],
      components: components.map(([component_id, placement]) => ({
        component_id,
        part_id: 'gear',
        placement,
      })),
    },
  });
}

function rendered(): RenderAssemblyPartMeshesResult {
  return {
    ok: true,
    error: null,
    parts: [
      {
        ok: true,
        error: null,
        part_id: 'gear',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      },
    ],
  };
}

const noRenderedParts = (): RenderAssemblyPartMeshesResult => ({
  ok: true,
  error: null,
  parts: [],
});

describe('SimpleCadAssemblyIncrementalPreview', () => {
  it('shares one BufferGeometry across instances and changes Placement in place', () => {
    const preview = new SimpleCadAssemblyIncrementalPreview();
    preview.apply({
      snapshot: snapshot('v1', [
        ['left', identity],
        ['right', { ...identity, origin: [10, 0, 0] }],
      ]),
      rendered_parts: rendered(),
      visibility: { right: false },
    });
    const left = preview.group.getObjectByName('left') as Mesh;
    const right = preview.group.getObjectByName('right') as Mesh;
    assert.equal(left.geometry, right.geometry);
    assert.equal(right.visible, false);

    preview.apply({
      snapshot: snapshot('v2', [
        ['left', { ...identity, origin: [-20, 0, 0] }],
        ['right', { ...identity, origin: [20, 0, 0] }],
      ]),
      rendered_parts: noRenderedParts(),
      visibility: { right: false },
    });
    assert.equal(preview.group.getObjectByName('left'), left);
    assert.equal(left.geometry, right.geometry);
    assert.deepEqual(left.matrix.elements.slice(12, 16), [-20, 0, 0, 1]);
    preview.dispose();
  });

  it('disposes a shared geometry only after its final Component stops using it', () => {
    const preview = new SimpleCadAssemblyIncrementalPreview();
    preview.apply({
      snapshot: snapshot('v1', [
        ['left', identity],
        ['right', identity],
      ]),
      rendered_parts: rendered(),
      visibility: {},
    });
    const geometry = (preview.group.getObjectByName('left') as Mesh).geometry;
    let disposeCount = 0;
    geometry.addEventListener('dispose', () => disposeCount++);
    preview.apply({
      snapshot: snapshot('v2', [['right', identity]]),
      rendered_parts: noRenderedParts(),
      visibility: {},
    });
    assert.equal(disposeCount, 0);
    preview.apply({
      snapshot: buildAssemblyRenderSnapshot({
        successful_artifact_version: 'v3',
        inspection: { ok: true, parts: [], components: [] },
      }),
      rendered_parts: noRenderedParts(),
      visibility: {},
    });
    assert.equal(disposeCount, 1);
    preview.dispose();
  });

  it('replaces changed geometry and disposes the unreferenced old buffer', () => {
    const preview = new SimpleCadAssemblyIncrementalPreview();
    preview.apply({
      snapshot: snapshot('v1', [['gear_component', identity]]),
      rendered_parts: rendered(),
      visibility: {},
    });
    const mesh = preview.group.getObjectByName('gear_component') as Mesh;
    const oldGeometry = mesh.geometry;
    let disposed = false;
    oldGeometry.addEventListener('dispose', () => {
      disposed = true;
    });
    preview.apply({
      snapshot: snapshot('v2', [['gear_component', identity]]),
      rendered_parts: rendered(),
      visibility: {},
    });
    assert.equal(preview.group.getObjectByName('gear_component'), mesh);
    assert.notEqual(mesh.geometry, oldGeometry);
    assert.equal(disposed, true);
    preview.dispose();
  });

  it('rejects a stale async update without replacing the committed version', () => {
    const preview = new SimpleCadAssemblyIncrementalPreview();
    preview.apply({
      snapshot: snapshot('v1', [['gear_component', identity]]),
      rendered_parts: rendered(),
      visibility: {},
      expected_previous_artifact_version: null,
    });
    assert.throws(
      () =>
        preview.apply({
          snapshot: snapshot('v2', [['gear_component', identity]]),
          rendered_parts: noRenderedParts(),
          visibility: {},
          expected_previous_artifact_version: 'some-other-version',
        }),
      /Stale Assembly mesh update/,
    );
    assert.equal(preview.getSnapshot()?.successful_artifact_version, 'v1');
    preview.dispose();
  });

  it('rejects duplicate Worker Part meshes before committing the snapshot', () => {
    const preview = new SimpleCadAssemblyIncrementalPreview();
    const duplicated = rendered();
    duplicated.parts.push({ ...duplicated.parts[0] });
    assert.throws(
      () =>
        preview.apply({
          snapshot: snapshot('v1', [['gear_component', identity]]),
          rendered_parts: duplicated,
          visibility: {},
        }),
      /duplicate Part mesh/,
    );
    assert.equal(preview.getSnapshot(), null);
    preview.dispose();
  });

  it('rejects a Worker response that omits a requested Part', () => {
    const preview = new SimpleCadAssemblyIncrementalPreview();
    assert.throws(
      () =>
        preview.apply({
          snapshot: snapshot('v1', [['gear_component', identity]]),
          rendered_parts: noRenderedParts(),
          visibility: {},
          expected_rendered_part_ids: ['gear'],
        }),
      /did not return requested Part mesh/,
    );
    assert.equal(preview.getSnapshot(), null);
    preview.dispose();
  });

  it('summarizes all component classes and timing fields', () => {
    const stats = buildAssemblyIncrementalMeshingStats({
      unique_part_count: 3,
      changes: {
        components: [
          { component_id: 'a', part_id: 'p1', kind: 'unchanged' },
          { component_id: 'b', part_id: 'p1', kind: 'placement_only' },
          { component_id: 'c', part_id: 'p2', kind: 'geometry_changed' },
          { component_id: 'd', part_id: 'p3', kind: 'added' },
          { component_id: 'e', part_id: 'p4', kind: 'removed' },
          {
            component_id: 'f',
            part_id: 'p5',
            kind: 'invalidated_by_dependency',
          },
        ],
        part_ids_to_mesh: ['p2', 'p3'],
      },
      remeshed_part_count: 2,
      worker_ms: 12,
      transfer_ms: 3,
      main_thread_render_ms: 4,
      parameter_debounce_ms: 205,
      run_code_ms: 30_000,
      inspection_ms: 1_000,
      total_preview_ms: 31_500,
      fallback_reason: 'mesh_cache_unavailable',
    });
    assert.deepEqual(stats.component_change_counts, {
      unchanged: 1,
      placement_only: 1,
      geometry_changed: 1,
      added: 1,
      removed: 1,
      invalidated_by_dependency: 1,
    });
    assert.equal(stats.remeshed_part_count, 2);
    assert.equal(stats.parameter_debounce_ms, 205);
    assert.equal(stats.run_code_ms, 30_000);
    assert.equal(stats.inspection_ms, 1_000);
    assert.equal(stats.meshing_worker_ms, 12);
    assert.equal(stats.total_preview_ms, 31_500);
    assert.equal(stats.full_mesh_fallback, true);
    assert.equal(stats.fallback_reason, 'mesh_cache_unavailable');
    assert.equal(stats.fallback_stage, null);
    assert.equal(stats.fallback_detail, null);
  });
});

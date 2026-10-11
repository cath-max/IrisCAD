import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssemblyPlacement } from './assemblyContract.ts';
import {
  ASSEMBLY_PART_MESHING_SETTINGS_VERSION,
  buildPartMeshCacheId,
  buildPlacementFingerprint,
  createComponentRenderState,
  normalizeAssemblyPlacement,
  placementToTransformMatrix,
} from './assemblyIncrementalMeshing.ts';

const identityPlacement: AssemblyPlacement = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, 1, 0],
  z_axis: [0, 0, 1],
};

function cacheId(partId: string): string {
  return buildPartMeshCacheId({
    part_id: partId,
    meshing_settings_version: ASSEMBLY_PART_MESHING_SETTINGS_VERSION,
  });
}

describe('Assembly incremental meshing contracts', () => {
  it('never shares a cache entry across different part_id values', () => {
    assert.notEqual(cacheId('gear_left'), cacheId('gear_right'));
  });

  it('shares a cache entry for the same Part and mesh settings', () => {
    assert.equal(cacheId('shared_gear'), cacheId('shared_gear'));
    assert.notEqual(
      buildPartMeshCacheId({
        part_id: 'shared_gear',
        meshing_settings_version: 'part-local-mesh-v2',
      }),
      cacheId('shared_gear'),
    );
  });

  it('normalizes negative zero before placement comparison', () => {
    const withNegativeZero: AssemblyPlacement = {
      ...identityPlacement,
      z_axis: [-0, -0, 1],
    };
    assert.deepEqual(
      normalizeAssemblyPlacement(withNegativeZero),
      identityPlacement,
    );
    assert.equal(
      buildPlacementFingerprint(withNegativeZero),
      buildPlacementFingerprint(identityPlacement),
    );
  });

  it('changes only the placement fingerprint and transform when a component moves', () => {
    const sharedCacheId = cacheId('shared_gear');
    const first = createComponentRenderState({
      component_id: 'gear_left',
      part_id: 'shared_gear',
      part_mesh_cache_id: sharedCacheId,
      placement: identityPlacement,
      visible: true,
    });
    const second = createComponentRenderState({
      component_id: 'gear_right',
      part_id: 'shared_gear',
      part_mesh_cache_id: sharedCacheId,
      placement: { ...identityPlacement, origin: [25, 0, 0] },
      visible: false,
    });

    assert.equal(first.part_mesh_cache_id, second.part_mesh_cache_id);
    assert.notEqual(first.placement_fingerprint, second.placement_fingerprint);
    assert.deepEqual(
      first.transform_matrix,
      placementToTransformMatrix(identityPlacement),
    );
    assert.deepEqual(second.transform_matrix.slice(12, 16), [25, 0, 0, 1]);
    assert.equal(first.visible, true);
    assert.equal(second.visible, false);
  });

  it('builds the expected column-major matrix for a rotated Placement', () => {
    assert.deepEqual(
      placementToTransformMatrix({
        origin: [12.5, -7.25, 3],
        x_axis: [0, 1, 0],
        y_axis: [-1, 0, 0],
        z_axis: [0, 0, 1],
      }),
      [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 12.5, -7.25, 3, 1],
    );
  });

  it('rejects incomplete cache and component identities', () => {
    assert.throws(
      () =>
        buildPartMeshCacheId({
          part_id: '',
          meshing_settings_version: ASSEMBLY_PART_MESHING_SETTINGS_VERSION,
        }),
      /part_id must not be empty/,
    );
    assert.throws(
      () =>
        createComponentRenderState({
          component_id: '',
          part_id: 'gear',
          part_mesh_cache_id: cacheId('gear'),
          placement: identityPlacement,
          visible: true,
        }),
      /component_id must not be empty/,
    );
  });
});

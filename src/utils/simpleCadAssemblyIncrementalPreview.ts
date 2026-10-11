import * as THREE from 'three';
import { CAD_PREVIEW_MATERIAL, CAD_PREVIEW_TINT } from './previewMaterial.ts';
import type {
  AssemblyRenderComponentState,
  AssemblyRenderChangeSet,
  AssemblyRenderSnapshot,
  AssemblyComponentChangeKind,
} from '../../shared/assemblyIncrementalMeshingDiff.ts';
import type {
  RenderAssemblyPartMeshesResult,
  RenderMeshResult,
} from '../worker/simpleCadToolWorker.ts';
import { buildSimpleCadBufferGeometry } from './simpleCadMeshGeometry.ts';

type GeometryEntry = {
  geometry: THREE.BufferGeometry;
  reference_count: number;
};

type ComponentEntry = {
  mesh: THREE.Mesh;
  part_mesh_cache_id: string;
};

export type AssemblyIncrementalMeshingStats = {
  unique_part_count: number;
  component_change_counts: Record<AssemblyComponentChangeKind, number>;
  remeshed_part_count: number;
  worker_ms: number;
  transfer_ms: number;
  main_thread_render_ms: number;
  parameter_debounce_ms: number | null;
  run_code_ms: number | null;
  inspection_ms: number | null;
  meshing_worker_ms: number;
  total_preview_ms: number | null;
  full_mesh_fallback: boolean;
  fallback_reason: string | null;
  fallback_stage: string | null;
  fallback_detail: string | null;
};

const ASSEMBLY_CHANGE_KINDS: readonly AssemblyComponentChangeKind[] = [
  'unchanged',
  'placement_only',
  'geometry_changed',
  'added',
  'removed',
  'invalidated_by_dependency',
];

export function buildAssemblyIncrementalMeshingStats(input: {
  unique_part_count: number;
  changes: AssemblyRenderChangeSet | null;
  remeshed_part_count: number;
  worker_ms?: number;
  transfer_ms?: number;
  main_thread_render_ms: number;
  parameter_debounce_ms?: number | null;
  run_code_ms?: number | null;
  inspection_ms?: number | null;
  total_preview_ms?: number | null;
  fallback_reason?: string | null;
  fallback_stage?: string | null;
  fallback_detail?: string | null;
}): AssemblyIncrementalMeshingStats {
  const componentChangeCounts = Object.fromEntries(
    ASSEMBLY_CHANGE_KINDS.map((kind) => [kind, 0]),
  ) as Record<AssemblyComponentChangeKind, number>;
  for (const change of input.changes?.components ?? []) {
    componentChangeCounts[change.kind] += 1;
  }
  return {
    unique_part_count: input.unique_part_count,
    component_change_counts: componentChangeCounts,
    remeshed_part_count: input.remeshed_part_count,
    worker_ms: input.worker_ms ?? 0,
    transfer_ms: input.transfer_ms ?? 0,
    main_thread_render_ms: input.main_thread_render_ms,
    parameter_debounce_ms: input.parameter_debounce_ms ?? null,
    run_code_ms: input.run_code_ms ?? null,
    inspection_ms: input.inspection_ms ?? null,
    meshing_worker_ms: input.worker_ms ?? 0,
    total_preview_ms: input.total_preview_ms ?? null,
    full_mesh_fallback: input.fallback_reason != null,
    fallback_reason: input.fallback_reason ?? null,
    fallback_stage: input.fallback_stage ?? null,
    fallback_detail: input.fallback_detail ?? null,
  };
}

function createAssemblyMaterial(
  geometry: THREE.BufferGeometry,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: CAD_PREVIEW_TINT,
    vertexColors: geometry.hasAttribute('color'),
    ...CAD_PREVIEW_MATERIAL,
  });
}

function disposeMeshMaterial(mesh: THREE.Mesh): void {
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  materials.forEach((material) => material.dispose());
}

function applyComponentTransform(
  mesh: THREE.Mesh,
  component: AssemblyRenderComponentState,
): void {
  mesh.matrixAutoUpdate = false;
  mesh.matrix.fromArray(componentTransform(component));
  mesh.matrixWorldNeedsUpdate = true;
}

function componentTransform(component: AssemblyRenderComponentState): number[] {
  const placement = component.placement;
  const [xx, xy, xz] = placement.x_axis;
  const [yx, yy, yz] = placement.y_axis;
  const [zx, zy, zz] = placement.z_axis;
  const [ox, oy, oz] = placement.origin;
  return [xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, ox, oy, oz, 1];
}

/** Owns one Assembly Group, its shared Part geometries, and Component meshes. */
export class SimpleCadAssemblyIncrementalPreview {
  readonly group = new THREE.Group();
  private readonly geometries = new Map<string, GeometryEntry>();
  private readonly components = new Map<string, ComponentEntry>();
  private snapshot: AssemblyRenderSnapshot | null = null;

  getSnapshot(): AssemblyRenderSnapshot | null {
    return this.snapshot;
  }

  private releaseGeometry(cacheId: string): void {
    const entry = this.geometries.get(cacheId);
    if (!entry) return;
    entry.reference_count -= 1;
    if (entry.reference_count <= 0) {
      entry.geometry.dispose();
      this.geometries.delete(cacheId);
    }
  }

  private retainGeometry(cacheId: string): THREE.BufferGeometry {
    const entry = this.geometries.get(cacheId);
    if (!entry) throw new Error(`Missing cached Part geometry: ${cacheId}.`);
    entry.reference_count += 1;
    return entry.geometry;
  }

  private stageRenderedParts(
    snapshot: AssemblyRenderSnapshot,
    rendered: RenderAssemblyPartMeshesResult,
    expectedRenderedPartIds?: readonly string[],
  ): void {
    if (!rendered.ok) {
      throw new Error(
        rendered.error?.what_happened ??
          rendered.error?.technical_details ??
          'Part mesh rendering failed.',
      );
    }
    const expectedParts = new Map(
      snapshot.parts.map((part) => [part.part_id, part]),
    );
    const returnedPartIds = new Set<string>();
    const expectedReturnedPartIds = expectedRenderedPartIds
      ? new Set(expectedRenderedPartIds)
      : null;
    for (const part of rendered.parts) {
      if (returnedPartIds.has(part.part_id)) {
        throw new Error(
          `Worker returned duplicate Part mesh: ${part.part_id}.`,
        );
      }
      if (
        expectedReturnedPartIds &&
        !expectedReturnedPartIds.has(part.part_id)
      ) {
        throw new Error(
          `Worker returned an unrequested Part mesh: ${part.part_id}.`,
        );
      }
      returnedPartIds.add(part.part_id);
      const expected = expectedParts.get(part.part_id);
      if (!part.ok || !expected) {
        throw new Error(`Part ${part.part_id} did not produce a usable mesh.`);
      }
      const cacheId = expected.part_mesh_cache_id;
      const geometry = buildSimpleCadBufferGeometry(part as RenderMeshResult, {
        center: false,
      });
      const existing = this.geometries.get(cacheId);
      if (!existing) {
        this.geometries.set(cacheId, { geometry, reference_count: 0 });
        continue;
      }
      const previousGeometry = existing.geometry;
      existing.geometry = geometry;
      for (const component of this.components.values()) {
        if (component.part_mesh_cache_id !== cacheId) continue;
        component.mesh.geometry = geometry;
        const material = component.mesh.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          material.vertexColors = geometry.hasAttribute('color');
          material.needsUpdate = true;
        }
      }
      previousGeometry.dispose();
    }
    for (const expectedPartId of expectedReturnedPartIds ?? []) {
      if (!returnedPartIds.has(expectedPartId)) {
        throw new Error(
          `Worker did not return requested Part mesh: ${expectedPartId}.`,
        );
      }
    }
  }

  apply(input: {
    snapshot: AssemblyRenderSnapshot;
    rendered_parts: RenderAssemblyPartMeshesResult;
    visibility: Readonly<Record<string, boolean>>;
    expected_previous_artifact_version?: string | null;
    expected_rendered_part_ids?: readonly string[];
  }): THREE.Group {
    const previousVersion = this.snapshot?.successful_artifact_version ?? null;
    if (
      input.expected_previous_artifact_version !== undefined &&
      input.expected_previous_artifact_version !== previousVersion
    ) {
      throw new Error(
        'Stale Assembly mesh update cannot replace a newer successful artifact.',
      );
    }

    this.stageRenderedParts(
      input.snapshot,
      input.rendered_parts,
      input.expected_rendered_part_ids,
    );
    const partCacheIds = new Map(
      input.snapshot.parts.map((part) => [
        part.part_id,
        part.part_mesh_cache_id,
      ]),
    );
    for (const component of input.snapshot.components) {
      const cacheId = partCacheIds.get(component.part_id);
      if (!cacheId || !this.geometries.has(cacheId)) {
        throw new Error(
          `Component ${component.component_id} has no cached geometry for Part ${component.part_id}.`,
        );
      }
    }

    const currentComponentIds = new Set(
      input.snapshot.components.map((component) => component.component_id),
    );
    for (const [componentId, entry] of this.components) {
      if (currentComponentIds.has(componentId)) continue;
      this.group.remove(entry.mesh);
      disposeMeshMaterial(entry.mesh);
      this.releaseGeometry(entry.part_mesh_cache_id);
      this.components.delete(componentId);
    }

    for (const component of input.snapshot.components) {
      const cacheId = partCacheIds.get(component.part_id)!;
      const existing = this.components.get(component.component_id);
      if (!existing) {
        const geometry = this.retainGeometry(cacheId);
        const mesh = new THREE.Mesh(geometry, createAssemblyMaterial(geometry));
        mesh.name = component.component_id;
        mesh.visible = input.visibility[component.component_id] !== false;
        applyComponentTransform(mesh, component);
        this.group.add(mesh);
        this.components.set(component.component_id, {
          mesh,
          part_mesh_cache_id: cacheId,
        });
        continue;
      }
      if (existing.part_mesh_cache_id !== cacheId) {
        const geometry = this.retainGeometry(cacheId);
        this.releaseGeometry(existing.part_mesh_cache_id);
        existing.mesh.geometry = geometry;
        const material = existing.mesh.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          material.vertexColors = geometry.hasAttribute('color');
          material.needsUpdate = true;
        }
        existing.part_mesh_cache_id = cacheId;
      }
      existing.mesh.visible =
        input.visibility[component.component_id] !== false;
      applyComponentTransform(existing.mesh, component);
    }

    for (const [cacheId, entry] of this.geometries) {
      if (entry.reference_count > 0) continue;
      entry.geometry.dispose();
      this.geometries.delete(cacheId);
    }
    this.snapshot = input.snapshot;
    return this.group;
  }

  setVisibility(visibility: Readonly<Record<string, boolean>>): void {
    for (const [componentId, entry] of this.components) {
      entry.mesh.visible = visibility[componentId] !== false;
    }
  }

  dispose(): void {
    for (const entry of this.components.values())
      disposeMeshMaterial(entry.mesh);
    for (const entry of this.geometries.values()) entry.geometry.dispose();
    this.components.clear();
    this.geometries.clear();
    this.group.clear();
    this.snapshot = null;
  }
}

import type { AssemblyPlacement } from './assemblyContract.ts';

/**
 * Increment this whenever local-mesh coordinates, tolerances, shading, or the
 * packed mesh contract changes. A version change deliberately invalidates all
 * prior Part mesh entries.
 */
export const ASSEMBLY_PART_MESHING_SETTINGS_VERSION =
  'part-local-mesh-v2:linear=0.12;angular=0.1;shading=smooth' as const;

export type PartMeshCacheKey = {
  part_id: string;
  meshing_settings_version: string;
};

/** Collision-safe string form suitable for a JavaScript Map key. */
export type PartMeshCacheId = string;

export type PartLocalMeshBuffers = {
  positions: Float32Array;
  normals: Float32Array;
  colors?: Float32Array;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
  vertex_count: number;
  triangle_count: number;
};

/**
 * Represents what one unique Part looks like in Part-local coordinates.
 * Component placement and visibility must never be stored here.
 */
export type PartMeshCacheEntry<TMesh = PartLocalMeshBuffers> = {
  cache_id: PartMeshCacheId;
  key: PartMeshCacheKey;
  local_mesh: TMesh;
};

export type PartMeshCache<TMesh = PartLocalMeshBuffers> = Map<
  PartMeshCacheId,
  PartMeshCacheEntry<TMesh>
>;

export const COMPONENT_PLACEMENT_FINGERPRINT_VERSION =
  'component-placement-frame-v1' as const;

export type NormalizedAssemblyPlacement = AssemblyPlacement;

/** Three.js-compatible column-major local-to-parent transform matrix. */
export type ComponentTransformMatrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Represents where one Component instance is and whether it is visible.
 * Its mesh is referenced by cache ID instead of being duplicated here.
 */
export type ComponentRenderState = {
  component_id: string;
  part_id: string;
  part_mesh_cache_id: PartMeshCacheId;
  placement: NormalizedAssemblyPlacement;
  placement_fingerprint: string;
  transform_matrix: ComponentTransformMatrix;
  visible: boolean;
};

export type ComponentRenderStateMap = Map<string, ComponentRenderState>;

function requireNonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
  return value;
}

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`);
  return Object.is(value, -0) ? 0 : value;
}

function normalizeVector(
  value: [number, number, number],
  field: string,
): [number, number, number] {
  return [
    requireFinite(value[0], `${field}[0]`),
    requireFinite(value[1], `${field}[1]`),
    requireFinite(value[2], `${field}[2]`),
  ];
}

/** Normalize OCP's possible -0.0 values before comparison or fingerprinting. */
export function normalizeAssemblyPlacement(
  placement: AssemblyPlacement,
): NormalizedAssemblyPlacement {
  return {
    origin: normalizeVector(placement.origin, 'origin'),
    x_axis: normalizeVector(placement.x_axis, 'x_axis'),
    y_axis: normalizeVector(placement.y_axis, 'y_axis'),
    z_axis: normalizeVector(placement.z_axis, 'z_axis'),
  };
}

/**
 * The complete normalized frame is already small and collision-free as JSON,
 * so Component Placement does not need a second cryptographic hash operation.
 */
export function buildPlacementFingerprint(
  placement: AssemblyPlacement,
): string {
  const normalized = normalizeAssemblyPlacement(placement);
  return JSON.stringify([
    COMPONENT_PLACEMENT_FINGERPRINT_VERSION,
    normalized.origin,
    normalized.x_axis,
    normalized.y_axis,
    normalized.z_axis,
  ]);
}

export function placementToTransformMatrix(
  placement: AssemblyPlacement,
): ComponentTransformMatrix {
  const normalized = normalizeAssemblyPlacement(placement);
  const [xx, xy, xz] = normalized.x_axis;
  const [yx, yy, yz] = normalized.y_axis;
  const [zx, zy, zz] = normalized.z_axis;
  const [ox, oy, oz] = normalized.origin;
  return [xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, ox, oy, oz, 1];
}

export function buildPartMeshCacheId(key: PartMeshCacheKey): PartMeshCacheId {
  requireNonEmpty(key.part_id, 'part_id');
  requireNonEmpty(key.meshing_settings_version, 'meshing_settings_version');
  return JSON.stringify([key.part_id, key.meshing_settings_version]);
}

export function createComponentRenderState(input: {
  component_id: string;
  part_id: string;
  part_mesh_cache_id: PartMeshCacheId;
  placement: AssemblyPlacement;
  visible: boolean;
}): ComponentRenderState {
  requireNonEmpty(input.component_id, 'component_id');
  requireNonEmpty(input.part_id, 'part_id');
  requireNonEmpty(input.part_mesh_cache_id, 'part_mesh_cache_id');
  const placement = normalizeAssemblyPlacement(input.placement);
  return {
    component_id: input.component_id,
    part_id: input.part_id,
    part_mesh_cache_id: input.part_mesh_cache_id,
    placement,
    placement_fingerprint: buildPlacementFingerprint(placement),
    transform_matrix: placementToTransformMatrix(placement),
    visible: input.visible,
  };
}

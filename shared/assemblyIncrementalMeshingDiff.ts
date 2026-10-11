import type { AssemblyPlacement } from './assemblyContract.ts';
import {
  ASSEMBLY_PART_MESHING_SETTINGS_VERSION,
  buildPartMeshCacheId,
  buildPlacementFingerprint,
  type PartMeshCacheId,
} from './assemblyIncrementalMeshing.ts';

export const ASSEMBLY_SUCCESSFUL_ARTIFACT_VERSION_FORMAT =
  'assembly-successful-artifact-v1' as const;

/** Exact in-memory identity: no hash collision can cross source or history revision. */
export function buildAssemblySuccessfulArtifactVersion(input: {
  model_revision: string;
  source_code: string;
}): string {
  requireNonEmpty(input.model_revision, 'model_revision');
  requireNonEmpty(input.source_code, 'source_code');
  return JSON.stringify([
    ASSEMBLY_SUCCESSFUL_ARTIFACT_VERSION_FORMAT,
    input.model_revision,
    input.source_code,
  ]);
}

export type AssemblyRenderPartState = {
  part_id: string;
  part_mesh_cache_id: PartMeshCacheId;
};

export type AssemblyRenderComponentState = {
  component_id: string;
  part_id: string;
  placement: AssemblyPlacement;
  placement_fingerprint: string;
};

/** A successfully inspected Assembly result, before any tessellation request. */
export type AssemblyRenderSnapshot = {
  successful_artifact_version: string;
  meshing_settings_version: string;
  parts: AssemblyRenderPartState[];
  components: AssemblyRenderComponentState[];
};

export type AssemblyComponentChangeKind =
  | 'unchanged'
  | 'placement_only'
  | 'geometry_changed'
  | 'added'
  | 'removed'
  | 'invalidated_by_dependency';

export type AssemblyComponentChange = {
  component_id: string;
  part_id: string;
  kind: AssemblyComponentChangeKind;
};

export type AssemblyRenderChangeSet = {
  components: AssemblyComponentChange[];
  part_ids_to_mesh: string[];
};

export type InspectedAssemblyRenderState = {
  ok: boolean;
  parts: Array<{
    part_id: string;
  }>;
  components: Array<{
    component_id: string;
    part_id: string;
    placement: AssemblyPlacement;
  }>;
};

function requireNonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
  return value;
}

function uniqueById<T>(
  items: readonly T[],
  getId: (item: T) => string,
  label: string,
): void {
  const ids = new Set<string>();
  for (const item of items) {
    const id = requireNonEmpty(getId(item), label);
    if (ids.has(id)) throw new Error(`Duplicate ${label}: ${id}.`);
    ids.add(id);
  }
}

export function buildAssemblyRenderSnapshot(input: {
  successful_artifact_version: string;
  inspection: InspectedAssemblyRenderState;
  meshing_settings_version?: string;
}): AssemblyRenderSnapshot {
  requireNonEmpty(
    input.successful_artifact_version,
    'successful_artifact_version',
  );
  if (!input.inspection.ok) {
    throw new Error('Assembly render state inspection did not succeed.');
  }
  uniqueById(input.inspection.parts, (part) => part.part_id, 'part_id');
  uniqueById(
    input.inspection.components,
    (component) => component.component_id,
    'component_id',
  );
  const meshingSettingsVersion =
    input.meshing_settings_version ?? ASSEMBLY_PART_MESHING_SETTINGS_VERSION;
  requireNonEmpty(meshingSettingsVersion, 'meshing_settings_version');
  const partIds = new Set(input.inspection.parts.map((part) => part.part_id));
  for (const component of input.inspection.components) {
    requireNonEmpty(component.part_id, 'component.part_id');
    if (!partIds.has(component.part_id)) {
      throw new Error(
        `Component ${component.component_id} references missing part_id: ${component.part_id}.`,
      );
    }
  }
  return {
    successful_artifact_version: input.successful_artifact_version,
    meshing_settings_version: meshingSettingsVersion,
    parts: input.inspection.parts.map((part) => ({
      part_id: part.part_id,
      part_mesh_cache_id: buildPartMeshCacheId({
        part_id: part.part_id,
        meshing_settings_version: meshingSettingsVersion,
      }),
    })),
    components: input.inspection.components.map((component) => ({
      ...component,
      placement_fingerprint: buildPlacementFingerprint(component.placement),
    })),
  };
}

/** Classify only from completed runtime inspection data, never LLM claims. */
export function classifyAssemblyRenderChanges(input: {
  previous: AssemblyRenderSnapshot | null;
  current: AssemblyRenderSnapshot;
  dirty_part_ids: readonly string[] | null;
}): AssemblyRenderChangeSet {
  const previousComponents = new Map(
    input.previous?.components.map((component) => [
      component.component_id,
      component,
    ]) ?? [],
  );
  const dirtyPartIds = new Set(input.dirty_part_ids ?? []);
  const changes: AssemblyComponentChange[] = [];
  for (const current of input.current.components) {
    const previous = previousComponents.get(current.component_id);
    let kind: AssemblyComponentChangeKind;
    if (!previous) {
      kind = 'added';
    } else if (previous.part_id !== current.part_id) {
      kind = 'geometry_changed';
    } else if (dirtyPartIds.has(current.part_id)) {
      kind = 'geometry_changed';
    } else if (
      previous.placement_fingerprint !== current.placement_fingerprint
    ) {
      kind = 'placement_only';
    } else {
      kind = 'unchanged';
    }
    changes.push({
      component_id: current.component_id,
      part_id: current.part_id,
      kind,
    });
  }

  const currentComponentIds = new Set(
    input.current.components.map((component) => component.component_id),
  );
  for (const previous of input.previous?.components ?? []) {
    if (!currentComponentIds.has(previous.component_id)) {
      changes.push({
        component_id: previous.component_id,
        part_id: previous.part_id,
        kind: 'removed',
      });
    }
  }

  const partIdsToMesh =
    input.dirty_part_ids === null
      ? input.current.parts.map((part) => part.part_id)
      : input.current.parts
          .filter((part) => dirtyPartIds.has(part.part_id))
          .map((part) => part.part_id);

  return {
    components: changes,
    part_ids_to_mesh: [...new Set(partIdsToMesh)],
  };
}

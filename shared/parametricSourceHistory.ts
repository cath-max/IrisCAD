import { patchParametricComponentsSchema } from './chatAi.ts';
import { analyzeAssemblyPatchScope } from './assemblyPatchScope.ts';
import {
  validateAssemblySourceLayout,
  type AssemblySourceSection,
  type AssemblySourceSectionKind,
} from './assemblySourceLayout.ts';
import type { AssemblySectionKey } from './assemblySectionExecution.ts';
import type { ParametricModelSnapshot } from './modelSnapshot.ts';
import { isParametricArtifact } from './parametricParts.ts';
import parseParameters from './parseParameters.ts';
import { updateParameter } from './updateParameter.ts';
import type { AssemblyComponent } from './assemblyContract.ts';
import type { ParametricArtifact, ProtectedRebuildContract } from './types.ts';

type HistoryMessage = {
  id: string;
  role: string;
  metadata?: { modelSnapshot?: ParametricModelSnapshot };
  parts: readonly unknown[];
};

type PatchInput = ReturnType<typeof patchParametricComponentsSchema.parse>;

export type PatchSectionChange = {
  operation: 'replace' | 'add' | 'delete';
  sectionKey: AssemblySectionKey;
};

export type AssemblyPatchImpact = {
  addedComponentIds: string[];
  removedComponentIds: string[];
  changedComponentIds: string[];
  addedPartIds: string[];
  changedPartIds: string[];
  removedPartIds: string[];
  dirtyPartIds: string[];
};

export type ArtifactResolution =
  | { ok: true; artifact: ParametricArtifact }
  | { ok: false; reason: string };

export type PatchMergeResult =
  | {
      ok: true;
      artifact: ParametricArtifact;
      affectedComponentIds: string[];
      changedSectionKeys: AssemblySectionKey[];
      changedSectionChanges: PatchSectionChange[];
      patchImpact: AssemblyPatchImpact;
    }
  | { ok: false; reason: string };

export function latestSuccessfulModelSnapshot(
  messages: readonly HistoryMessage[],
): ParametricModelSnapshot | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const snapshot = messages[index].metadata?.modelSnapshot;
    if (snapshot) return snapshot;
  }
  return undefined;
}

/** Rebuild one historical artifact from its nearest full-build checkpoint. */
export function resolveParametricArtifactRevision(
  messages: readonly HistoryMessage[],
  modelRevision: string,
): ArtifactResolution {
  return resolveRevision(messages, modelRevision, new Set());
}

/**
 * Validate and merge a local patch. The LLM cannot authorize its own impact:
 * affected components are recomputed from the persisted source and snapshot.
 */
export function mergeParametricComponentPatch({
  baseArtifact,
  baseSnapshot,
  patchInput,
}: {
  baseArtifact: ParametricArtifact;
  baseSnapshot: ParametricModelSnapshot;
  patchInput: unknown;
}): PatchMergeResult {
  const parsedPatch = patchParametricComponentsSchema.safeParse(patchInput);
  if (!parsedPatch.success) {
    return {
      ok: false,
      reason: 'Local patch input does not match the IrisCAD patch contract.',
    };
  }
  const patch = parsedPatch.data;
  if (patch.base_model_revision !== baseSnapshot.modelRevision) {
    return {
      ok: false,
      reason: `Patch base revision ${patch.base_model_revision} is stale; current revision is ${baseSnapshot.modelRevision}.`,
    };
  }
  if (
    baseArtifact.artifact_kind !== 'assembly' ||
    baseSnapshot.artifactKind !== 'assembly'
  ) {
    return {
      ok: false,
      reason:
        'Local patches currently support successful Assembly artifacts only.',
    };
  }

  const mergedCode = mergeMarkedSections(baseArtifact.code, patch);
  if (!mergedCode.ok) return mergedCode;

  const artifact: ParametricArtifact = {
    ...baseArtifact,
    code: mergedCode.code,
    planned_changes: patch.planned_changes,
    model_summary: patch.model_summary,
    protected_rebuild: undefined,
  };
  const impact = recomputePatchImpact({
    baseArtifact,
    mergedArtifact: artifact,
    baseSnapshot,
    patch,
  });
  if (!impact.ok) return impact;

  return {
    ok: true,
    artifact,
    affectedComponentIds: impact.affectedComponentIds,
    changedSectionKeys: mergedCode.changedSectionKeys,
    changedSectionChanges: mergedCode.changedSectionChanges,
    patchImpact: impact.patchImpact,
  };
}

/** Source-level half of protected rebuild validation. */
export function validateProtectedRebuildSource({
  baseArtifact,
  baseSnapshot,
  nextArtifact,
  contract,
}: {
  baseArtifact: ParametricArtifact;
  baseSnapshot: ParametricModelSnapshot;
  nextArtifact: ParametricArtifact;
  contract: ProtectedRebuildContract;
}): string[] {
  const issues: string[] = [];
  if (
    baseArtifact.artifact_kind !== 'assembly' ||
    nextArtifact.artifact_kind !== 'assembly'
  ) {
    return [
      'Protected rebuild requires an Assembly before and after the rebuild.',
    ];
  }
  const before = validateAssemblySourceLayout(baseArtifact.code);
  const after = validateAssemblySourceLayout(nextArtifact.code);
  if (!before.ok)
    return [
      'Protected rebuild base source has an invalid Assembly section layout.',
    ];
  if (!after.ok)
    return [
      'Protected rebuild source has an invalid Assembly section layout.',
      ...after.issues,
    ];

  const replaceKeys = uniqueContractKeys(
    contract.replace_sections,
    'replace',
    issues,
  );
  const addKeys = uniqueContractKeys(contract.add_sections, 'add', issues);
  const affectedIds = new Set(contract.affected_component_ids);
  for (const section of [
    ...contract.replace_sections,
    ...contract.add_sections,
  ]) {
    if (
      section.section_kind === 'parameters' ||
      section.section_kind === 'helper'
    ) {
      issues.push(
        `Protected rebuild cannot authorize global ${section.section_kind} section ${section.section_id}.`,
      );
    }
    if (
      section.section_kind === 'component' &&
      !affectedIds.has(section.section_id)
    ) {
      issues.push(
        `Changed component section must be listed in affected_component_ids: ${section.section_id}.`,
      );
    }
  }
  for (const section of contract.replace_sections) {
    if (section.section_kind !== 'part') continue;
    for (const component of baseSnapshot.components) {
      if (
        component.part_id === section.section_id &&
        !affectedIds.has(component.component_id)
      ) {
        issues.push(
          `Component using replaced Part must be listed in affected_component_ids: ${component.component_id}.`,
        );
      }
    }
  }
  for (const key of replaceKeys) {
    if (addKeys.has(key))
      issues.push(`Section ${key} cannot be both replaced and added.`);
  }

  const beforeByKey = sectionMap(before.layout.sections);
  const afterByKey = sectionMap(after.layout.sections);
  for (const [key, oldSection] of beforeByKey) {
    const newSection = afterByKey.get(key);
    if (!newSection) {
      issues.push(`Protected rebuild cannot delete existing section ${key}.`);
      continue;
    }
    if (oldSection.source !== newSection.source && !replaceKeys.has(key)) {
      issues.push(
        `Unapproved section changed during protected rebuild: ${key}.`,
      );
    }
  }
  for (const key of replaceKeys) {
    if (!beforeByKey.has(key) || !afterByKey.has(key)) {
      issues.push(
        `Approved replacement must exist before and after rebuild: ${key}.`,
      );
    }
  }
  for (const key of afterByKey.keys()) {
    if (!beforeByKey.has(key) && !addKeys.has(key)) {
      issues.push(
        `Unapproved section was added during protected rebuild: ${key}.`,
      );
    }
  }
  for (const key of addKeys) {
    if (beforeByKey.has(key) || !afterByKey.has(key)) {
      issues.push(
        `Approved addition must be new and present after rebuild: ${key}.`,
      );
    }
  }

  if (
    !contract.allow_mate_notes_change &&
    !jsonEqual(baseArtifact.mate_notes ?? [], nextArtifact.mate_notes ?? [])
  ) {
    issues.push('mate_notes changed without protected-rebuild approval.');
  }
  return issues;
}

/** Runtime half: unchanged components must keep identity, Part and Placement. */
export function validateProtectedRebuildRuntime({
  baseSnapshot,
  nextComponents,
  contract,
}: {
  baseSnapshot: ParametricModelSnapshot;
  nextComponents: readonly AssemblyComponent[];
  contract: ProtectedRebuildContract;
}): string[] {
  const issues: string[] = [];
  const affected = new Set(contract.affected_component_ids);
  const before = new Map(
    baseSnapshot.components.map((component) => [
      component.component_id,
      component,
    ]),
  );
  const after = new Map(
    nextComponents.map((component) => [component.component_id, component]),
  );
  for (const [componentId, oldComponent] of before) {
    if (affected.has(componentId)) continue;
    const newComponent = after.get(componentId);
    if (!newComponent) {
      issues.push(
        `Unaffected component disappeared during protected rebuild: ${componentId}.`,
      );
      continue;
    }
    if (!jsonEqual(oldComponent, newComponent)) {
      issues.push(
        `Unaffected component metadata or Placement changed: ${componentId}.`,
      );
    }
  }
  for (const componentId of after.keys()) {
    if (!before.has(componentId) && !affected.has(componentId)) {
      issues.push(
        `New component is missing from affected_component_ids: ${componentId}.`,
      );
    }
  }
  return issues;
}

function resolveRevision(
  messages: readonly HistoryMessage[],
  modelRevision: string,
  visiting: Set<string>,
): ArtifactResolution {
  if (visiting.has(modelRevision)) {
    return {
      ok: false,
      reason: `Patch history contains a cycle at revision ${modelRevision}.`,
    };
  }
  visiting.add(modelRevision);

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const unknownPart of message.parts) {
      if (!isRecord(unknownPart) || typeof unknownPart.toolCallId !== 'string')
        continue;
      if (`${message.id}:${unknownPart.toolCallId}` !== modelRevision) continue;
      if (
        unknownPart.state !== 'output-available' ||
        !isSuccessfulOutput(unknownPart.output)
      ) {
        return {
          ok: false,
          reason: `Revision ${modelRevision} is not a successful CAD result.`,
        };
      }
      if (unknownPart.type === 'tool-build_parametric_model') {
        return isParametricArtifact(unknownPart.input)
          ? {
              ok: true,
              artifact: applySnapshotOverrides(
                unknownPart.input,
                message.metadata?.modelSnapshot,
              ),
            }
          : {
              ok: false,
              reason: `Full-build checkpoint ${modelRevision} has no valid artifact.`,
            };
      }
      if (unknownPart.type === 'tool-patch_parametric_components') {
        const patch = patchParametricComponentsSchema.safeParse(
          unknownPart.input,
        );
        if (!patch.success) {
          return {
            ok: false,
            reason: `Patch revision ${modelRevision} has invalid persisted input.`,
          };
        }
        const base = resolveRevision(
          messages,
          patch.data.base_model_revision,
          visiting,
        );
        if (!base.ok) return base;
        const merged = mergeMarkedSections(base.artifact.code, patch.data);
        return merged.ok
          ? {
              ok: true,
              artifact: applySnapshotOverrides(
                {
                  ...base.artifact,
                  code: merged.code,
                  planned_changes: patch.data.planned_changes,
                  model_summary: patch.data.model_summary,
                  protected_rebuild: undefined,
                },
                message.metadata?.modelSnapshot,
              ),
            }
          : merged;
      }
    }
  }
  return {
    ok: false,
    reason: `No successful CAD history node matches revision ${modelRevision}.`,
  };
}

function mergeMarkedSections(
  baseCode: string,
  patch: PatchInput,
):
  | {
      ok: true;
      code: string;
      changedSectionKeys: AssemblySectionKey[];
      changedSectionChanges: PatchSectionChange[];
    }
  | { ok: false; reason: string } {
  const validation = validateAssemblySourceLayout(baseCode);
  if (!validation.ok) {
    return {
      ok: false,
      reason:
        'The base Assembly source does not have a valid stable section layout.',
    };
  }
  const byKey = sectionMap(validation.layout.sections);
  const replacements = new Map<
    string,
    { source: string; section: AssemblySourceSection }
  >();
  for (const replacement of patch.replacements) {
    const key = sectionKey(replacement.section_kind, replacement.section_id);
    const existing = byKey.get(key);
    if (!existing)
      return { ok: false, reason: `Patch targets missing section ${key}.` };
    if (replacements.has(key))
      return { ok: false, reason: `Patch repeats section ${key}.` };
    const single = parseReplacementSection(replacement.replacement_source);
    if (!single.ok) return single;
    if (
      single.kind !== replacement.section_kind ||
      single.id !== replacement.section_id
    ) {
      return {
        ok: false,
        reason: `Replacement marker does not match declared section ${key}.`,
      };
    }
    replacements.set(key, { source: single.source, section: existing });
  }

  const deletions = new Map<string, AssemblySourceSection>();
  for (const deletion of patch.deletions) {
    const key = sectionKey(deletion.section_kind, deletion.section_id);
    const existing = byKey.get(key);
    if (!existing)
      return { ok: false, reason: `Patch targets missing section ${key}.` };
    if (replacements.has(key) || deletions.has(key)) {
      return { ok: false, reason: `Patch repeats section ${key}.` };
    }
    deletions.set(key, existing);
  }

  const additions: Array<{
    key: AssemblySectionKey;
    kind: 'part' | 'component';
    source: string;
  }> = [];
  for (const addition of patch.additions) {
    const key = sectionKey(addition.section_kind, addition.section_id);
    if (byKey.has(key) || replacements.has(key) || deletions.has(key)) {
      return {
        ok: false,
        reason: `Added section conflicts with an existing patch target: ${key}.`,
      };
    }
    const single = parseReplacementSection(addition.section_source);
    if (!single.ok) return single;
    if (
      single.kind !== addition.section_kind ||
      single.id !== addition.section_id
    ) {
      return {
        ok: false,
        reason: `Addition marker does not match declared section ${key}.`,
      };
    }
    additions.push({
      key: key as AssemblySectionKey,
      kind: addition.section_kind,
      source: single.source,
    });
  }

  const lines = baseCode.replace(/\r\n/g, '\n').split('\n');
  const existingOperations: Array<{
    key: string;
    section: AssemblySourceSection;
    source?: string;
  }> = [
    ...[...replacements.entries()].map(([key, replacement]) => ({
      key,
      section: replacement.section,
      source: replacement.source,
    })),
    ...[...deletions.entries()].map(([key, section]) => ({ key, section })),
  ].sort((left, right) => right.section.startLine - left.section.startLine);
  for (const operation of existingOperations) {
    lines.splice(
      operation.section.startLine - 1,
      operation.section.endLine - operation.section.startLine + 1,
      ...(operation.source?.split('\n') ?? []),
    );
  }
  insertAddedSections(
    lines,
    additions.filter((addition) => addition.kind === 'part'),
    'assembly_setup',
  );
  insertAddedSections(
    lines,
    additions.filter((addition) => addition.kind === 'component'),
    'assembly_result',
  );

  const code = lines.join('\n');
  const mergedValidation = validateAssemblySourceLayout(code);
  if (!mergedValidation.ok) {
    return {
      ok: false,
      reason: `Merged Assembly source is invalid: ${mergedValidation.issues.join(' ')}`,
    };
  }
  const deletedPartIds = [...deletions.values()]
    .filter((section) => section.kind === 'part')
    .map((section) => section.id);
  for (const partId of deletedPartIds) {
    if (
      mergedValidation.layout.sections
        .filter((section) => section.kind === 'component')
        .some((section) => referencesIdentifier(section.source, partId))
    ) {
      return {
        ok: false,
        reason: `Cannot delete Part ${partId}: a remaining Component section still references it.`,
      };
    }
  }
  const changedSectionChanges: PatchSectionChange[] = [
    ...[...replacements.keys()].map((sectionKey) => ({
      operation: 'replace' as const,
      sectionKey: sectionKey as AssemblySectionKey,
    })),
    ...additions.map((addition) => ({
      operation: 'add' as const,
      sectionKey: addition.key,
    })),
    ...[...deletions.keys()].map((sectionKey) => ({
      operation: 'delete' as const,
      sectionKey: sectionKey as AssemblySectionKey,
    })),
  ];
  return {
    ok: true,
    code,
    changedSectionKeys: changedSectionChanges.map(
      (change) => change.sectionKey,
    ),
    changedSectionChanges,
  };
}

function insertAddedSections(
  lines: string[],
  additions: readonly { source: string }[],
  beforeKind: 'assembly_setup' | 'assembly_result',
): void {
  if (additions.length === 0) return;
  const marker = `# iriscad:${beforeKind}`;
  const index = lines.findIndex((line) => line.trim() === marker);
  if (index < 0) throw new Error(`Missing ${beforeKind} insertion marker.`);
  const sourceLines = additions.flatMap((addition) => [
    ...addition.source.split('\n'),
    '',
  ]);
  lines.splice(index, 0, ...sourceLines);
}

function referencesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recomputePatchImpact({
  baseArtifact,
  mergedArtifact,
  baseSnapshot,
  patch,
}: {
  baseArtifact: ParametricArtifact;
  mergedArtifact: ParametricArtifact;
  baseSnapshot: ParametricModelSnapshot;
  patch: PatchInput;
}):
  | {
      ok: true;
      affectedComponentIds: string[];
      patchImpact: AssemblyPatchImpact;
    }
  | { ok: false; reason: string } {
  if (
    patch.replacements.some(
      (replacement) =>
        replacement.section_kind === 'assembly_setup' ||
        replacement.section_kind === 'assembly_result',
    )
  ) {
    return {
      ok: false,
      reason:
        'Changing assembly_setup or assembly_result requires a complete rebuild.',
    };
  }
  const beforeLayout = validateAssemblySourceLayout(baseArtifact.code);
  const afterLayout = validateAssemblySourceLayout(mergedArtifact.code);
  if (!beforeLayout.ok || !afterLayout.ok) {
    return {
      ok: false,
      reason:
        'Patch impact requires valid Assembly sections before and after merging.',
    };
  }

  const addedComponentIds = new Set(
    patch.additions
      .filter((addition) => addition.section_kind === 'component')
      .map((addition) => addition.section_id),
  );
  const removedComponentIds = new Set(
    patch.deletions
      .filter((deletion) => deletion.section_kind === 'component')
      .map((deletion) => deletion.section_id),
  );
  const changedComponentIds = new Set(
    patch.replacements
      .filter((replacement) => replacement.section_kind === 'component')
      .map((replacement) => replacement.section_id),
  );
  const addedPartIds = new Set(
    patch.additions
      .filter((addition) => addition.section_kind === 'part')
      .map((addition) => addition.section_id),
  );
  const changedPartIds = new Set(
    patch.replacements
      .filter((replacement) => replacement.section_kind === 'part')
      .map((replacement) => replacement.section_id),
  );
  const explicitlyRemovedPartIds = new Set(
    patch.deletions
      .filter((deletion) => deletion.section_kind === 'part')
      .map((deletion) => deletion.section_id),
  );
  const affected = new Set<string>([
    ...addedComponentIds,
    ...removedComponentIds,
    ...changedComponentIds,
  ]);

  const beforeComponentParts = new Map(
    baseSnapshot.components.map((component) => [
      component.component_id,
      component.part_id,
    ]),
  );
  const afterPartIds = new Set(
    afterLayout.layout.sections
      .filter((section) => section.kind === 'part')
      .map((section) => section.id),
  );
  const afterComponentParts = new Map<string, string | null>();
  for (const section of afterLayout.layout.sections) {
    if (section.kind !== 'component') continue;
    const priorPartId = beforeComponentParts.get(section.id);
    const needsSourceLookup =
      addedComponentIds.has(section.id) || changedComponentIds.has(section.id);
    if (!needsSourceLookup) {
      if (!beforeComponentParts.has(section.id)) {
        return {
          ok: false,
          reason: `Component ${section.id} is new but was not declared as an addition.`,
        };
      }
      afterComponentParts.set(section.id, priorPartId ?? null);
      continue;
    }
    const partId = referencedPartId(section, afterPartIds);
    if (!partId) {
      return {
        ok: false,
        reason: `Component ${section.id} must explicitly reference exactly one current Part.`,
      };
    }
    afterComponentParts.set(section.id, partId);
  }

  for (const componentId of removedComponentIds) {
    if (!beforeComponentParts.has(componentId)) {
      return {
        ok: false,
        reason: `Deleted Component ${componentId} does not exist in the successful Assembly baseline.`,
      };
    }
  }
  for (const partId of addedPartIds) {
    if (![...afterComponentParts.values()].includes(partId)) {
      return {
        ok: false,
        reason: `Added Part ${partId} is not referenced by a new or existing Component.`,
      };
    }
  }

  for (const replacement of patch.replacements) {
    if (replacement.section_kind === 'part') {
      const decision = analyzeAssemblyPatchScope({
        code: baseArtifact.code,
        snapshot: baseSnapshot,
        target: {
          kind: 'part',
          partId: replacement.section_id,
          change: 'geometry',
        },
      });
      if (decision.mode !== 'local')
        return { ok: false, reason: decision.reason };
      decision.scope.affectedComponentIds.forEach((id) => affected.add(id));
    } else if (replacement.section_kind === 'component') {
      const decision = analyzeAssemblyPatchScope({
        code: baseArtifact.code,
        snapshot: baseSnapshot,
        target: {
          kind: 'component',
          componentId: replacement.section_id,
          change: 'placement',
        },
      });
      if (decision.mode !== 'local')
        return { ok: false, reason: decision.reason };
      decision.scope.affectedComponentIds.forEach((id) => affected.add(id));
    } else if (replacement.section_kind === 'helper') {
      const decision = analyzeAssemblyPatchScope({
        code: baseArtifact.code,
        snapshot: baseSnapshot,
        target: {
          kind: 'helper',
          helperId: replacement.section_id,
          change: 'implementation',
        },
      });
      if (decision.mode !== 'local')
        return { ok: false, reason: decision.reason };
      decision.scope.affectedComponentIds.forEach((id) => affected.add(id));
      partIdsInScope(decision.scope).forEach((id) => changedPartIds.add(id));
    }
  }

  if (
    patch.replacements.some(
      (replacement) => replacement.section_kind === 'parameters',
    )
  ) {
    const oldParameters = new Map(
      parseParameters(baseArtifact.code).map((item) => [item.name, item.value]),
    );
    const newParameters = new Map(
      parseParameters(mergedArtifact.code).map((item) => [
        item.name,
        item.value,
      ]),
    );
    if (
      oldParameters.size !== newParameters.size ||
      [...oldParameters.keys()].some((name) => !newParameters.has(name))
    ) {
      return {
        ok: false,
        reason: 'Adding or removing parameters requires a complete rebuild.',
      };
    }
    const changedNames = [...oldParameters.keys()].filter(
      (name) => !jsonEqual(oldParameters.get(name), newParameters.get(name)),
    );
    if (changedNames.length === 0) {
      return {
        ok: false,
        reason:
          'The parameters replacement does not change an exposed parameter value.',
      };
    }
    for (const parameterName of changedNames) {
      const decision = analyzeAssemblyPatchScope({
        code: baseArtifact.code,
        snapshot: baseSnapshot,
        target: { kind: 'parameter', parameterName, change: 'value' },
      });
      if (decision.mode !== 'local')
        return { ok: false, reason: decision.reason };
      decision.scope.affectedComponentIds.forEach((id) => affected.add(id));
      partIdsInScope(decision.scope).forEach((id) => changedPartIds.add(id));
    }
  }

  const dirtyPartIds = new Set([...addedPartIds, ...changedPartIds]);
  for (const [componentId, partId] of afterComponentParts) {
    if (partId && dirtyPartIds.has(partId)) affected.add(componentId);
  }
  const afterReferencedPartIds = new Set(
    [...afterComponentParts.values()].filter(
      (partId): partId is string => partId !== null,
    ),
  );
  const removedPartIds = new Set(explicitlyRemovedPartIds);
  for (const partId of beforeComponentParts.values()) {
    if (partId && !afterReferencedPartIds.has(partId))
      removedPartIds.add(partId);
  }

  const expected = [...affected].sort();
  const declared = [...new Set(patch.affected_component_ids)].sort();
  if (!jsonEqual(expected, declared)) {
    return {
      ok: false,
      reason: `affected_component_ids must exactly match IrisCAD analysis: ${JSON.stringify(expected)}.`,
    };
  }
  return {
    ok: true,
    affectedComponentIds: expected,
    patchImpact: {
      addedComponentIds: sorted(addedComponentIds),
      removedComponentIds: sorted(removedComponentIds),
      changedComponentIds: sorted(changedComponentIds),
      addedPartIds: sorted(addedPartIds),
      changedPartIds: sorted(changedPartIds),
      removedPartIds: sorted(removedPartIds),
      dirtyPartIds: sorted(dirtyPartIds),
    },
  };
}

function referencedPartId(
  section: AssemblySourceSection,
  partIds: ReadonlySet<string>,
): string | null {
  const referenced = [...partIds].filter((partId) =>
    referencesIdentifier(section.source, partId),
  );
  return referenced.length === 1 ? referenced[0] : null;
}

function partIdsInScope(scope: {
  editableSections: AssemblySourceSection[];
  dependencySections: AssemblySourceSection[];
}): string[] {
  return [...scope.editableSections, ...scope.dependencySections]
    .filter((section) => section.kind === 'part')
    .map((section) => section.id);
}

function sorted(items: ReadonlySet<string>): string[] {
  return [...items].sort();
}

function parseReplacementSection(source: string):
  | {
      ok: true;
      kind: AssemblySourceSectionKind;
      id: string;
      source: string;
    }
  | { ok: false; reason: string } {
  const normalized = source.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');
  const start = lines[0]?.match(
    /^#\s*iriscad:(parameters|helper|part|assembly_setup|component|assembly_result)(?:\s+([a-z][a-z0-9_]*))?\s*$/,
  );
  const implicitId =
    start?.[1] === 'parameters' ||
    start?.[1] === 'assembly_setup' ||
    start?.[1] === 'assembly_result'
      ? start[1]
      : undefined;
  const id = start?.[2] ?? implicitId;
  if (!start || !id || (implicitId && start[2]) || (!implicitId && !start[2])) {
    return {
      ok: false,
      reason:
        'Each replacement must contain exactly one complete allowed IrisCAD section.',
    };
  }
  if (lines.slice(1).some((line) => /^#\s*iriscad:/.test(line))) {
    return {
      ok: false,
      reason:
        'A replacement cannot contain nested or additional IrisCAD section markers.',
    };
  }
  return {
    ok: true,
    kind: start[1] as AssemblySourceSectionKind,
    id,
    source: normalized,
  };
}

function uniqueContractKeys(
  sections: ProtectedRebuildContract['replace_sections'],
  label: string,
  issues: string[],
): Set<string> {
  const keys = new Set<string>();
  for (const section of sections) {
    const key = sectionKey(section.section_kind, section.section_id);
    if (keys.has(key))
      issues.push(`Protected rebuild repeats ${label} section ${key}.`);
    keys.add(key);
  }
  return keys;
}

function sectionMap(
  sections: readonly AssemblySourceSection[],
): Map<string, AssemblySourceSection> {
  return new Map(
    sections.map((section) => [sectionKey(section.kind, section.id), section]),
  );
}

function sectionKey(kind: AssemblySourceSectionKind, id: string): string {
  return `${kind}/${id}`;
}

function isSuccessfulOutput(value: unknown): boolean {
  return isRecord(value) && value.status === 'success';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applySnapshotOverrides(
  artifact: ParametricArtifact,
  snapshot: ParametricModelSnapshot | undefined,
): ParametricArtifact {
  if (!snapshot) return artifact;
  let code = artifact.code;
  for (const parameter of snapshot.parameters) {
    code = updateParameter(code, parameter);
  }
  return {
    ...artifact,
    code,
    assembly_visibility:
      snapshot.assemblyVisibility ?? artifact.assembly_visibility,
  };
}

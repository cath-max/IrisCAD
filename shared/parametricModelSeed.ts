import type { AppUIMessage, ParametricCompileOutput } from './chatAi.ts';
import type { ParametricModelSnapshot } from './modelSnapshot.ts';
import { asParametricParts } from './parametricParts.ts';
import { resolveParametricArtifactRevision } from './parametricSourceHistory.ts';
import parseParameters from './parseParameters.ts';
import type { ParametricArtifact } from './types.ts';

type CompileSuccess = Extract<ParametricCompileOutput, { status: 'success' }>;

export type SeedHistoryMessage = AppUIMessage & {
  parent_message_id: string | null;
};

export type ParametricSeedData = {
  artifact: ParametricArtifact;
  output: CompileSuccess;
  parameters: ParametricModelSnapshot['parameters'];
  components: ParametricModelSnapshot['components'];
  bom: ParametricModelSnapshot['bom'];
  mateNotes: ParametricModelSnapshot['mateNotes'];
  assemblyVisibility?: ParametricModelSnapshot['assemblyVisibility'];
  recentChanges: string[];
  sourceModelRevision: string;
};

/** Return only the active parent chain; sibling revisions are not copied. */
export function activeMessageBranch(
  messages: readonly SeedHistoryMessage[],
  leafId: string | null,
): SeedHistoryMessage[] {
  if (!leafId) return [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const branch: SeedHistoryMessage[] = [];
  const seen = new Set<string>();
  let currentId: string | null = leafId;
  while (currentId) {
    if (seen.has(currentId)) return [];
    seen.add(currentId);
    const message = byId.get(currentId);
    if (!message) return [];
    branch.push(message);
    currentId = message.parent_message_id;
  }
  return branch.reverse();
}

/** Resolve the newest runnable model on one active branch into a clean seed. */
export function resolveLatestParametricSeed(
  branch: readonly SeedHistoryMessage[],
): ParametricSeedData | undefined {
  for (
    let messageIndex = branch.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = branch[messageIndex];
    const snapshotRevision = message.metadata?.modelSnapshot?.modelRevision;
    const revision = snapshotRevision ?? latestSuccessfulRevision(message);
    if (!revision) continue;

    const resolved = resolveParametricArtifactRevision(branch, revision);
    if (!resolved.ok) continue;
    const output = compileOutputForRevision(branch, revision);
    if (!output) continue;

    const persistedSnapshot = [...branch]
      .reverse()
      .map((item) => item.metadata?.modelSnapshot)
      .find((snapshot) => snapshot?.modelRevision === revision);
    const artifactKind =
      resolved.artifact.artifact_kind ??
      output.artifact_kind ??
      (output.result_type === 'Assembly' ? 'assembly' : 'model');
    const artifact: ParametricArtifact = {
      ...resolved.artifact,
      version: resolved.artifact.version || 'v1',
      artifact_kind: artifactKind,
      mate_notes:
        resolved.artifact.mate_notes ??
        output.mate_notes ??
        persistedSnapshot?.mateNotes,
      assembly_visibility:
        resolved.artifact.assembly_visibility ??
        persistedSnapshot?.assemblyVisibility,
      model_summary:
        resolved.artifact.model_summary?.trim() ||
        persistedSnapshot?.modelSummary ||
        summarizeSeed(output),
      protected_rebuild: undefined,
    };

    return {
      artifact,
      output: withoutHistoricalInspection(output),
      parameters:
        persistedSnapshot?.parameters ?? parseParameters(artifact.code),
      components: persistedSnapshot?.components ?? output.components ?? [],
      bom: persistedSnapshot?.bom ?? output.bom ?? [],
      mateNotes:
        persistedSnapshot?.mateNotes ??
        artifact.mate_notes ??
        output.mate_notes ??
        [],
      assemblyVisibility:
        persistedSnapshot?.assemblyVisibility ?? artifact.assembly_visibility,
      recentChanges: persistedSnapshot?.recentChanges ?? [],
      sourceModelRevision: revision,
    };
  }
  return undefined;
}

function latestSuccessfulRevision(
  message: SeedHistoryMessage,
): string | undefined {
  const parts = asParametricParts(message.parts);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (
      (part.type === 'tool-build_parametric_model' ||
        part.type === 'tool-patch_parametric_components') &&
      part.state === 'output-available' &&
      part.output.status === 'success'
    ) {
      return `${message.id}:${part.toolCallId}`;
    }
  }
  return undefined;
}

function compileOutputForRevision(
  branch: readonly SeedHistoryMessage[],
  revision: string,
): CompileSuccess | undefined {
  for (const message of branch) {
    for (const part of asParametricParts(message.parts)) {
      if (
        `${message.id}:${'toolCallId' in part ? part.toolCallId : ''}` ===
          revision &&
        (part.type === 'tool-build_parametric_model' ||
          part.type === 'tool-patch_parametric_components') &&
        part.state === 'output-available' &&
        part.output.status === 'success'
      ) {
        return part.output;
      }
    }
  }
  return undefined;
}

function withoutHistoricalInspection(output: CompileSuccess): CompileSuccess {
  return {
    ...output,
    inspection: output.inspection
      ? { ...output.inspection, imageAttached: false }
      : undefined,
    message:
      'Existing SimpleCADAPI model loaded into a clean parametric session.',
  };
}

function summarizeSeed(output: CompileSuccess): string {
  if (output.artifact_kind === 'assembly') {
    return `Imported Assembly with ${output.components?.length ?? 0} components and ${output.bom?.length ?? 0} BOM lines.`;
  }
  return `Imported ${output.result_type} SimpleCADAPI model.`;
}

import type {
  AssemblyBomLine,
  AssemblyComponent,
  MateNote,
} from './assemblyContract.ts';
import type { Parameter, ParametricArtifact } from './types.ts';

/**
 * Compact, persisted description of the last successfully runnable artifact.
 * The Python source is deliberately not copied here: `source` points at the
 * already-persisted build tool input in the same assistant message.
 */
export type ParametricModelSnapshot = {
  /** Stable, system-created token for optimistic local-edit checks. */
  modelRevision: string;
  /** LLM-authored display version (currently normally `v1`). */
  artifactVersion: string;
  source: {
    messageId: string;
    toolCallId: string;
  };
  artifactKind: 'model' | 'assembly';
  parameters: Parameter[];
  components: AssemblyComponent[];
  bom: AssemblyBomLine[];
  mateNotes: MateNote[];
  assemblyVisibility?: Record<string, boolean>;
  recentChanges: string[];
  modelSummary: string;
  savedAt: string;
  /** Provenance for a clean parametric conversation seeded from an existing model. */
  origin?: {
    kind: 'past_creation' | 'imported_code' | 'recovery';
    sourceConversationId?: string;
    sourceModelRevision?: string;
    sourceTitle?: string;
  };
};

type SnapshotInput = {
  messageId: string;
  toolCallId: string;
  artifact: ParametricArtifact;
  parameters: Parameter[];
  components?: AssemblyComponent[];
  bom?: AssemblyBomLine[];
  mateNotes?: MateNote[];
  recentChanges: string[];
  savedAt?: string;
};

export function createParametricModelSnapshot({
  messageId,
  toolCallId,
  artifact,
  parameters,
  components = [],
  bom = [],
  mateNotes = [],
  recentChanges,
  savedAt = new Date().toISOString(),
}: SnapshotInput): ParametricModelSnapshot {
  return {
    modelRevision: `${messageId}:${toolCallId}`,
    artifactVersion: artifact.version,
    source: { messageId, toolCallId },
    artifactKind: artifact.artifact_kind ?? 'model',
    parameters,
    components,
    bom,
    mateNotes,
    assemblyVisibility: artifact.assembly_visibility,
    recentChanges: recentChanges.slice(0, 2),
    modelSummary: artifact.model_summary ?? '',
    savedAt,
  };
}

/** Keep a snapshot aligned with a successful parameter-only local rerun. */
export function refreshSnapshotParameters(
  snapshot: ParametricModelSnapshot,
  parameters: Parameter[],
  savedAt = new Date().toISOString(),
): ParametricModelSnapshot {
  return { ...snapshot, parameters, savedAt };
}

export function refreshSnapshotAssemblyVisibility(
  snapshot: ParametricModelSnapshot,
  assemblyVisibility: Record<string, boolean> | undefined,
  savedAt = new Date().toISOString(),
): ParametricModelSnapshot {
  return { ...snapshot, assemblyVisibility, savedAt };
}

/** Extract the two newest successful, user-meaningful model changes. */
export function recentSuccessfulModelChanges(
  messages: readonly { role: string; parts: unknown }[],
): string[] {
  const changes: string[] = [];
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) continue;

    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.parts[partIndex] as Record<string, unknown>;
      if (
        (part.type !== 'tool-build_parametric_model' &&
          part.type !== 'tool-patch_parametric_components') ||
        part.state !== 'output-available' ||
        !isSuccessfulBuildOutput(part.output) ||
        !hasPlannedChanges(part.input)
      ) {
        continue;
      }
      changes.push(part.input.planned_changes);
      if (changes.length === 2) return changes;
    }
  }
  return changes;
}

function isSuccessfulBuildOutput(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'success'
  );
}

function hasPlannedChanges(
  value: unknown,
): value is { planned_changes: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { planned_changes?: unknown }).planned_changes ===
      'string' &&
    (value as { planned_changes: string }).planned_changes.trim().length > 0
  );
}

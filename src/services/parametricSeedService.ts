import { supabase } from '@/lib/supabase';
import {
  DEFAULT_INSPECTION_VIEW_LABELS,
  hasResultShape,
  reopenSimpleCadSession,
  runSimpleCadCode,
} from '@/worker/simpleCadToolWorker';
import {
  validateV1AssemblyStructure,
  type AssemblyBomLine,
  type AssemblyComponent,
} from '@shared/assemblyContract';
import type { AppUIMessage, ParametricCompileOutput } from '@shared/chatAi';
import { createParametricModelSnapshot } from '@shared/modelSnapshot';
import {
  activeMessageBranch,
  resolveLatestParametricSeed,
  type ParametricSeedData,
  type SeedHistoryMessage,
} from '@shared/parametricModelSeed';
import parseParameters from '@shared/parseParameters';
import type { Message, Model, ParametricArtifact } from '@shared/types';

type CompileSuccess = Extract<ParametricCompileOutput, { status: 'success' }>;

export type ParametricSeedOrigin = {
  kind: 'past_creation' | 'imported_code' | 'recovery';
  sourceConversationId?: string;
  sourceModelRevision?: string;
  sourceTitle?: string;
};

export async function loadParametricSeedFromConversation({
  conversationId,
  leafId,
}: {
  conversationId: string;
  leafId: string | null;
}): Promise<ParametricSeedData> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .overrideTypes<Message[]>();
  if (error) throw error;
  const messages = (data ?? []).map(toSeedHistoryMessage);
  const branch = activeMessageBranch(messages, leafId);
  const seed = resolveLatestParametricSeed(branch);
  if (!seed) {
    throw new Error(
      'This conversation has no successful parametric model to continue.',
    );
  }
  return seed;
}

export async function prepareImportedParametricSeed({
  code,
  sessionId,
}: {
  code: string;
  sessionId: string;
}): Promise<ParametricSeedData> {
  const trimmedCode = code.trim();
  if (!trimmedCode)
    throw new Error('Paste SimpleCADAPI code before importing.');

  await reopenSimpleCadSession(sessionId);
  const runResult = await runSimpleCadCode(trimmedCode, sessionId);
  if (!runResult.ok) {
    throw new Error(
      runResult.error?.what_happened ??
        runResult.error?.technical_details ??
        'The imported SimpleCADAPI code failed to run.',
    );
  }
  if (!hasResultShape(runResult.shapes)) {
    throw new Error(
      'The imported code must assign its final CAD result to `result`.',
    );
  }

  const artifactKind =
    runResult.result_type === 'Assembly' ? 'assembly' : 'model';
  if (
    artifactKind === 'model' &&
    runResult.result_type !== 'Solid' &&
    runResult.result_type !== 'Compound'
  ) {
    throw new Error(
      'The imported `result` must be a Solid, Compound, or Assembly.',
    );
  }

  const components: AssemblyComponent[] = runResult.assembly?.components ?? [];
  const bom: AssemblyBomLine[] = runResult.assembly?.bom ?? [];
  if (artifactKind === 'assembly') {
    const violations = validateV1AssemblyStructure(runResult.assembly);
    if (violations.length > 0) {
      throw new Error(
        `The imported Assembly does not satisfy the V1 contract: ${violations.join(' ')}`,
      );
    }
  }

  const modelSummary =
    artifactKind === 'assembly'
      ? `Imported Assembly with ${components.length} components and ${bom.length} BOM lines.`
      : `Imported ${runResult.result_type} SimpleCADAPI model.`;
  const artifact: ParametricArtifact = {
    title: 'Imported SimpleCADAPI Model',
    version: 'v1',
    code: trimmedCode,
    artifact_kind: artifactKind,
    mate_notes: [],
    model_summary: modelSummary,
  };
  const output: CompileSuccess =
    artifactKind === 'assembly'
      ? {
          status: 'success',
          message: 'Imported SimpleCADAPI Assembly executed successfully.',
          artifact_kind: 'assembly',
          result_type: 'Assembly',
          assembly: runResult.assembly
            ? {
                assembly_id: runResult.assembly.assembly_id,
                name: runResult.assembly.name,
              }
            : undefined,
          components,
          bom,
          mate_notes: [],
          assembly_step: { available: true },
          shapes: runResult.shapes,
          inspection: {
            views: [...DEFAULT_INSPECTION_VIEW_LABELS],
            imageAttached: false,
          },
        }
      : {
          status: 'success',
          message: 'Imported SimpleCADAPI model executed successfully.',
          artifact_kind: 'model',
          result_type: runResult.result_type as 'Solid' | 'Compound',
          shapes: runResult.shapes,
          inspection: {
            views: [...DEFAULT_INSPECTION_VIEW_LABELS],
            imageAttached: false,
          },
        };

  return {
    artifact,
    output,
    parameters: parseParameters(trimmedCode),
    components,
    bom,
    mateNotes: [],
    recentChanges: [],
    sourceModelRevision: 'imported-code',
  };
}

export async function createConversationFromParametricSeed({
  userId,
  model,
  title,
  seed,
  origin,
  conversationId = crypto.randomUUID(),
}: {
  userId: string;
  model: Model;
  title: string;
  seed: ParametricSeedData;
  origin: ParametricSeedOrigin;
  conversationId?: string;
}): Promise<string> {
  const messageId = crypto.randomUUID();
  const toolCallId = crypto.randomUUID();
  const artifact: ParametricArtifact = {
    ...seed.artifact,
    protected_rebuild: undefined,
    planned_changes: undefined,
  };
  const snapshot = {
    ...createParametricModelSnapshot({
      messageId,
      toolCallId,
      artifact,
      parameters: seed.parameters,
      components: seed.components,
      bom: seed.bom,
      mateNotes: seed.mateNotes,
      recentChanges: seed.recentChanges,
    }),
    assemblyVisibility: seed.assemblyVisibility,
    origin: {
      ...origin,
      sourceModelRevision:
        origin.sourceModelRevision ?? seed.sourceModelRevision,
    },
  };
  const part = {
    type: 'tool-build_parametric_model',
    toolCallId,
    state: 'output-available',
    input: artifact,
    output: {
      ...seed.output,
      inspection: seed.output.inspection
        ? { ...seed.output.inspection, imageAttached: false }
        : undefined,
      message:
        'Existing SimpleCADAPI model loaded into a clean parametric session.',
    },
  } as AppUIMessage['parts'][number];

  const { error: conversationError } = await supabase
    .from('conversations')
    .insert({
      id: conversationId,
      user_id: userId,
      title: title.trim() || artifact.title,
      type: 'parametric',
      settings: { model },
    });
  if (conversationError) throw conversationError;

  const { error: messageError } = await supabase.from('messages').insert({
    id: messageId,
    conversation_id: conversationId,
    role: 'assistant',
    parts: JSON.parse(JSON.stringify([part])),
    metadata: JSON.parse(JSON.stringify({ model, modelSnapshot: snapshot })),
    parent_message_id: null,
  });
  if (messageError) throw messageError;
  return conversationId;
}

function toSeedHistoryMessage(message: Message): SeedHistoryMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata,
    parent_message_id: message.parent_message_id,
  };
}

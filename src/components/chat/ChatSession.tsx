import { DEFAULT_CONVERSATION_TITLES, modelTitle } from '@shared/modelNaming';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { SuggestionPills } from '@/components/chat/SuggestionPills';
import TextAreaChat from '@/components/TextAreaChat';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCachedAiChat } from '@/hooks/useCachedAiChat';
import { useToast } from '@/hooks/use-toast';
import { apiUrl } from '@/services/api';
import { messageRowToChatMessage, type ChatMessage } from '@/lib/aiMessages';
import { collectStuckToolRecovery } from '@/components/chat/stuckToolRecovery';
import { AssistantRowMissingError } from '@/services/messageService';
import { supabase } from '@/lib/supabase';
import {
  USER_BUILD_GUIDANCE_PREFIX,
  patchParametricComponentsSchema,
  type AppUIMessage,
  type ConversationSuggestionsUpdate,
  type ConversationTitleUpdate,
  type ParametricCompileOutput,
} from '@shared/chatAi';
import {
  validateV1AssemblyStructure,
  validateV1MateNotes,
  type AssemblyComponent,
} from '@shared/assemblyContract';
import {
  ASSEMBLY_SOURCE_LAYOUT_GUIDANCE,
  validateAssemblySourceLayout,
} from '@shared/assemblySourceLayout';
import { planAssemblySectionExecution } from '@shared/assemblySectionExecutionPlanner';
import type { AssemblySectionChange } from '@shared/assemblySectionExecutionPlanner';
import { buildAssemblySuccessfulArtifactVersion } from '@shared/assemblyIncrementalMeshingDiff';
import {
  type AssemblyPatchImpact,
  latestSuccessfulModelSnapshot,
  mergeParametricComponentPatch,
  resolveParametricArtifactRevision,
  validateProtectedRebuildRuntime,
  validateProtectedRebuildSource,
} from '@shared/parametricSourceHistory';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Tree from '@shared/Tree';
import { isParametricArtifact } from '@shared/parametricParts';
import parseParameters from '@shared/parseParameters';
import {
  createParametricModelSnapshot,
  recentSuccessfulModelChanges,
} from '@shared/modelSnapshot';
import type {
  Conversation,
  Message,
  Model,
  ParametricArtifact,
} from '@shared/types';
import {
  DEFAULT_INSPECTION_VIEW_LABELS,
  enterSimpleCadSession,
  analyzeSimpleCadAssemblySections,
  hasResultShape,
  reopenSimpleCadSession,
  renderResultInspectionBlob,
  inspectSimpleCadGeometry,
  RESULT_SHAPE_NAME,
  runSimpleCadCode,
  runSimpleCadAssemblySections,
  type ErrorGuidance,
  type RunCodeResult,
} from '@/worker/simpleCadToolWorker';
import { useQueryClient } from '@tanstack/react-query';
import posthog from 'posthog-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProfile } from '@/services/profileService';
import { useReportAgentActivity } from '@/contexts/AgentActivityContext';
import { useNavigate } from '@tanstack/react-router';
import {
  createConversationFromParametricSeed,
  loadParametricSeedFromConversation,
} from '@/services/parametricSeedService';

const DEFAULT_SOFT_MAX_BUILD_ROUNDS = 20;

/** Survives ChatSession remount so Continue waits aren't treated as stuck. */
const pendingBuildApprovalsByConversation = new Map<string, Set<string>>();

function pendingBuildApprovalsFor(conversationId: string): Set<string> {
  let pending = pendingBuildApprovalsByConversation.get(conversationId);
  if (!pending) {
    pending = new Set();
    pendingBuildApprovalsByConversation.set(conversationId, pending);
  }
  return pending;
}

function softMaxBuildRounds(profileRounds: number | null | undefined): number {
  if (
    typeof profileRounds !== 'number' ||
    !Number.isFinite(profileRounds) ||
    profileRounds < 1
  ) {
    return DEFAULT_SOFT_MAX_BUILD_ROUNDS;
  }
  return Math.min(40, Math.max(1, Math.round(profileRounds)));
}

function hardMaxBuildRounds(soft: number): number {
  return Math.min(soft * 2, 80);
}

interface ChatSessionProps {
  conversation: Conversation;
  /** Raw message rows from the DB query — used to build the sibling tree. */
  dbMessages: Message[];
  /** Branch to seed `chat.messages` on mount of this conversation's Chat. */
  initialBranch: AppUIMessage[];
  model: Model;
  setModel: (model: Model) => void;
  /** True when the token budget is exhausted; locks the input + retry. */
  isDisabled: boolean;

  // Action handlers — each does its DB writes in the parent and returns
  // the data ChatSession needs to keep `chat.messages` in sync. See the
  // architecture plan §5 for the exact contract.
  onSendParts: (
    parts: AppUIMessage['parts'],
  ) => Promise<{ userMessageId: string }>;
  onRetry: (assistant: ChatMessage) => Promise<void>;
  onEdit: (
    original: ChatMessage,
    parts: AppUIMessage['parts'],
  ) => Promise<{ newUserMessageId: string; parentPath: AppUIMessage[] }>;
  onRestore: (assistant: ChatMessage) => Promise<{ newBranch: AppUIMessage[] }>;
  onSelectLeaf: (messageId: string) => Promise<void>;
  /** Pure tree walker — closes over the parent's `dbTree`. */
  branchForLeaf: (leafId: string) => AppUIMessage[];

  onToolOutput: (
    messageId: string,
    nextParts: AppUIMessage['parts'],
    metadata?: AppUIMessage['metadata'],
  ) => Promise<void>;
  onChangeRating: (messageId: string, rating: number) => void;
  onViewArtifact: (
    artifact: ParametricArtifact,
    messageId: string,
    assemblyComponents?: AssemblyComponent[],
    workerResult?: {
      modelRevision: string;
      dirtyPartIds: string[] | null;
      removedPartIds: string[];
      affectedComponentIds: string[];
    },
  ) => void;
  /** Fired whenever the SDK's submitted/streaming flag flips. Lets the
   *  parent show the bouncing loader in the preview pane while the model
   *  is still producing the next artifact. */
  onLoadingChange?: (isLoading: boolean) => void;
}

type ToolMessagePart = Extract<
  AppUIMessage['parts'][number],
  { state: string }
>;

function isToolMessagePart(
  part: AppUIMessage['parts'][number],
): part is ToolMessagePart {
  return part.type.startsWith('tool-') && 'state' in part;
}

function lastAssistantMessageIsCompleteWithParametricMutation({
  messages,
}: {
  messages: AppUIMessage[];
}) {
  const message = messages[messages.length - 1];
  if (!message || message.role !== 'assistant') return false;
  if (message.parts.some((part) => part.type === 'tool-answer_user')) {
    return false;
  }

  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) =>
      part.type === 'step-start' ? index : lastIndex,
    -1,
  );
  const toolParts = message.parts
    .slice(lastStepStartIndex + 1)
    .filter(isToolMessagePart);

  return (
    toolParts.some(
      (part) =>
        part.type === 'tool-build_parametric_model' ||
        part.type === 'tool-patch_parametric_components',
    ) &&
    !toolParts.some((part) => part.type === 'tool-answer_user') &&
    toolParts.every(
      (part) =>
        part.state === 'output-available' || part.state === 'output-error',
    )
  );
}

/** Index of the latest user message, or -1 if none. */
function lastUserMessageIndex(messages: AppUIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/**
 * Completed CAD mutation rounds since the latest user message
 * (each finished tool part counts as one round).
 */
function countCadMutationRoundsSinceLastUser(messages: AppUIMessage[]): number {
  const lastUserIndex = lastUserMessageIndex(messages);
  if (lastUserIndex < 0) return 0;

  let count = 0;
  for (let i = lastUserIndex + 1; i < messages.length; i++) {
    for (const part of messages[i].parts) {
      if (
        (part.type === 'tool-build_parametric_model' ||
          part.type === 'tool-patch_parametric_components') &&
        'state' in part &&
        (part.state === 'output-available' || part.state === 'output-error')
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Whether the latest completed build since the last user message compiled.
 * `null` if there is no completed build yet.
 */
function lastCadMutationCompileSucceeded(
  messages: AppUIMessage[],
): boolean | null {
  const lastUserIndex = lastUserMessageIndex(messages);
  if (lastUserIndex < 0) return null;

  for (let i = messages.length - 1; i > lastUserIndex; i--) {
    for (let p = messages[i].parts.length - 1; p >= 0; p--) {
      const part = messages[i].parts[p];
      if (
        (part.type !== 'tool-build_parametric_model' &&
          part.type !== 'tool-patch_parametric_components') ||
        !('state' in part)
      ) {
        continue;
      }
      if (part.state === 'output-error') return false;
      if (part.state !== 'output-available') continue;
      const output = 'output' in part ? part.output : undefined;
      if (
        output &&
        typeof output === 'object' &&
        !Array.isArray(output) &&
        'status' in output
      ) {
        return (output as ParametricCompileOutput).status === 'success';
      }
      return false;
    }
  }
  return null;
}

function answerUserInput(input: unknown): { message: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const message = (input as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? { message } : null;
}

function toErrorGuidancePayload(error: ErrorGuidance | null) {
  if (!error) return null;
  return {
    operation: error.operation,
    what_happened: error.what_happened,
    possible_causes: error.possible_causes,
    how_to_fix: error.how_to_fix,
    technical_details: error.technical_details,
    signature: error.signature,
    documentation_hint: error.documentation_hint,
  };
}

function buildRunFailureOutput(
  runResult: RunCodeResult,
): ParametricCompileOutput {
  return {
    status: 'error',
    message: 'SimpleCADAPI execution failed. See ErrorGuidance fields.',
    errorGuidance: toErrorGuidancePayload(runResult.error),
    stdout: runResult.stdout || undefined,
    stderr: runResult.stderr || undefined,
    shapes: runResult.shapes,
  };
}

function buildContractFailureOutput(
  message: string,
  shapes?: string[],
): ParametricCompileOutput {
  return {
    status: 'error',
    message,
    errorGuidance: null,
    shapes,
  };
}

/** Prefix for G3 skip-with-guidance tool outputs (also used by MessageBubble). */
function buildUserGuidanceSkipOutput(
  guidance: string,
): ParametricCompileOutput {
  return buildContractFailureOutput(
    [
      USER_BUILD_GUIDANCE_PREFIX,
      'Do not execute or reuse the previous tool-input code as-is.',
      `User guidance: ${guidance}`,
      'Call build_parametric_model again with one complete corrected SimpleCADAPI script that follows the guidance. Include planned_changes summarizing the revision.',
    ].join(' '),
  );
}

/**
 * Owns the AI-SDK Chat lifecycle for a conversation. Everything that touches
 * `chat.sendMessage` / `chat.regenerate` / `chat.setMessages` /
 * `chat.addToolOutput` lives here — and only here. DB writes are delegated
 * upward to `EditorView` via the `on*` props, which keeps the two layers
 * honest: the parent owns "what the tree looks like", this component owns
 * "what the SDK is doing right now".
 *
 * The split means we never have a stale `chat.messages` racing against a
 * React Query refetch: a chat-state update only happens as the direct
 * consequence of an action handler that the parent already awaited.
 */
export function ChatSession({
  conversation,
  dbMessages,
  initialBranch,
  model,
  setModel,
  isDisabled,
  onSendParts,
  onRetry,
  onEdit,
  onRestore,
  onSelectLeaf,
  branchForLeaf,
  onToolOutput,
  onChangeRating,
  onViewArtifact,
  onLoadingChange,
}: ChatSessionProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: profile } = useProfile();
  const softMaxRounds = softMaxBuildRounds(profile?.agent_max_build_rounds);
  const hardMaxRounds = hardMaxBuildRounds(softMaxRounds);
  const requireBuildApproval = profile?.agent_require_build_approval === true;
  const requireBuildApprovalRef = useRef(requireBuildApproval);
  requireBuildApprovalRef.current = requireBuildApproval;
  const approvedBuildToolCallIdsRef = useRef(new Set<string>());
  const [pendingBuildApprovalIds, setPendingBuildApprovalIds] = useState(
    () => new Set(pendingBuildApprovalsFor(conversation.id)),
  );
  const [showCleanSessionRecovery, setShowCleanSessionRecovery] =
    useState(false);
  const [isStartingCleanSession, setIsStartingCleanSession] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setPendingBuildApprovalIds(
      new Set(pendingBuildApprovalsFor(conversation.id)),
    );
  }, [conversation.id]);

  const markBuildApprovalPending = useCallback(
    (toolCallId: string) => {
      const pending = pendingBuildApprovalsFor(conversation.id);
      pending.add(toolCallId);
      setPendingBuildApprovalIds(new Set(pending));
    },
    [conversation.id],
  );

  const clearBuildApprovalPending = useCallback(
    (toolCallId: string) => {
      const pending = pendingBuildApprovalsFor(conversation.id);
      if (!pending.delete(toolCallId)) return;
      setPendingBuildApprovalIds(new Set(pending));
    },
    [conversation.id],
  );

  // First enter of a conversation resets the Worker namespace; later
  // remounts of the same id keep shapes (needed for upcoming export).
  useEffect(() => {
    void enterSimpleCadSession(conversation.id).catch((error) => {
      console.warn('SimpleCADAPI session enter failed:', error);
    });
  }, [conversation.id]);

  // ───────────────────────────────────────────────────────────────────────
  // Transport — strips client state out of the wire body. Server reads the
  // branch from `conversations.current_message_leaf_id` and walks parents
  // in the DB, so anything the SDK might put in `messages` is ignored.
  // ───────────────────────────────────────────────────────────────────────
  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  // The chat endpoint returns 402 when the user is out of tokens. The AI
  // SDK transport doesn't expose the response status on its `onError`
  // hook — we have to intercept at the fetch layer. On 402 we invalidate
  // the billing status query so the credit notices and
  // EditorView's input-disable react immediately instead of waiting up
  // to 30s for the next status poll. A toast covers the in-between
  // moment where the user just hit send and got nothing back.
  //
  // We also set `billingErrorHandledRef` so the SDK's `onError` (which
  // fires next, because a 402 isn't a valid SSE stream) doesn't stack a
  // second generic toast on top of the specific billing one.
  const billingErrorHandledRef = useRef(false);
  const billingAwareFetch = useCallback<typeof fetch>(
    async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 402) {
        billingErrorHandledRef.current = true;
        queryClient.invalidateQueries({ queryKey: ['billing', 'status'] });
        toast({
          title: "You're out of tokens",
          description:
            'Upgrade your plan or buy a token pack to keep chatting.',
          variant: 'destructive',
        });
      }
      return response;
    },
    [queryClient, toast],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<AppUIMessage>({
        api: apiUrl('parametric-chat'),
        headers: authHeaders,
        fetch: billingAwareFetch,
        prepareSendMessagesRequest: ({ body }) => ({
          body: {
            conversationId: conversation.id,
            model,
            ...(body ?? {}),
          },
        }),
      }),
    [authHeaders, billingAwareFetch, conversation.id, model],
  );

  // ───────────────────────────────────────────────────────────────────────
  // Tool-output bridge via `onToolCall` (no useEffect, no dedupe ref).
  //
  // The SDK fires this exactly once per tool call as soon as the model's
  // input completes. We render the SimpleCADAPI result locally, upload the preview,
  // persist the assistant's parts to DB (so the server reads the right
  // thing on auto-continuation), and only then call `chat.addToolOutput`
  // which lets `sendAutomaticallyWhen` continue the CAD build/review loop.
  // ───────────────────────────────────────────────────────────────────────
  const chatRef = useRef<ReturnType<typeof useCachedAiChat> | null>(null);
  // Latest `chat.messages` snapshot for use inside `onToolCall` (callbacks
  // baked at Chat-init time would otherwise close over the initial array).
  const messagesRef = useRef<AppUIMessage[]>(initialBranch);
  // Set when persisting a tool's `output-available` to the DB fails. The
  // server reads the branch from the DB (never from client-sent messages), so
  // auto-resubmitting after a failed persist would continue against a stale
  // branch — at best a wasted round-trip the server has to recover from. While
  // this is set, `sendAutomaticallyWhen` returns false so the loop pauses and
  // the user can retry. Reset at the top of each `handleToolCall`.
  const persistFailedRef = useRef(false);
  // Soft/hard build-round toasts fire at most once per user turn.
  const buildCapToastKeyRef = useRef<string | null>(null);

  const handleToolCall = useCallback(
    async ({
      toolCall,
    }: {
      toolCall: {
        toolName: string;
        toolCallId: string;
        input: unknown;
      };
    }) => {
      if (
        toolCall.toolName !== 'build_parametric_model' &&
        toolCall.toolName !== 'patch_parametric_components' &&
        toolCall.toolName !== 'answer_user'
      ) {
        return;
      }
      const chat = chatRef.current;
      if (!chat) return;

      // Fresh tool call → clear any prior persist-failure pause.
      persistFailedRef.current = false;

      // Prefer the SDK's live `chat.messages` — it's always current.
      // `messagesRef.current` is a React-mirrored copy that lags one
      // commit behind, and onToolCall can fire before that commit lands.
      const findAssistant = (msgs: readonly AppUIMessage[]) =>
        msgs.find(
          (msg) =>
            msg.role === 'assistant' &&
            msg.parts.some(
              (p) =>
                p.type === `tool-${toolCall.toolName}` &&
                'toolCallId' in p &&
                p.toolCallId === toolCall.toolCallId,
            ),
        );
      const assistant =
        findAssistant(chat.messages as AppUIMessage[]) ??
        findAssistant(messagesRef.current);

      if (toolCall.toolName === 'answer_user') {
        const output = answerUserInput(toolCall.input);
        if (!output) {
          const errorText = 'answer_user input was missing a message.';
          // Persist the error so the DB row isn't left with a dangling
          // `input-available` tool call (which would 500 the next send before
          // the server-side sanitizer rewrites it).
          if (assistant) {
            const nextParts = assistant.parts.map((existing) =>
              existing.type === 'tool-answer_user' &&
              existing.toolCallId === toolCall.toolCallId
                ? ({
                    type: 'tool-answer_user',
                    toolCallId: toolCall.toolCallId,
                    state: 'output-error',
                    input: toolCall.input,
                    errorText,
                  } as AppUIMessage['parts'][number])
                : existing,
            ) as AppUIMessage['parts'];
            try {
              await onToolOutput(assistant.id, nextParts);
            } catch (persistError) {
              console.warn(
                'Failed to persist answer_user error to DB:',
                persistError,
              );
            }
          }
          chat.addToolOutput({
            state: 'output-error',
            tool: 'answer_user',
            toolCallId: toolCall.toolCallId,
            errorText,
          });
          return;
        }

        const successPart = {
          type: 'tool-answer_user',
          toolCallId: toolCall.toolCallId,
          state: 'output-available',
          input: output,
          output,
        } as AppUIMessage['parts'][number];

        if (assistant) {
          const nextParts = assistant.parts.map((existing) => {
            if (
              existing.type === 'tool-answer_user' &&
              existing.toolCallId === toolCall.toolCallId
            ) {
              return successPart;
            }
            if (
              (existing.type === 'reasoning' || existing.type === 'text') &&
              existing.state === 'streaming'
            ) {
              return { ...existing, state: 'done' as const };
            }
            return existing;
          }) as AppUIMessage['parts'];

          try {
            await onToolOutput(assistant.id, nextParts);
          } catch (persistError) {
            console.warn(
              'Failed to persist answer_user output to DB:',
              persistError,
            );
            toast({
              title: "Couldn't save the reply",
              description:
                'Your message is shown but may not survive a refresh. Please retry if it disappears.',
              variant: 'destructive',
            });
          }
        }

        chat.addToolOutput({
          tool: 'answer_user',
          toolCallId: toolCall.toolCallId,
          output,
        });
        return;
      }

      const cadToolName = toolCall.toolName;
      const cadToolType =
        cadToolName === 'build_parametric_model'
          ? 'tool-build_parametric_model'
          : 'tool-patch_parametric_components';
      const liveMessages =
        (chat.messages as AppUIMessage[]) ?? messagesRef.current;
      const sourceMessages = mergePersistedSourceHistory(
        dbMessages,
        liveMessages,
      );

      //approval gate: pause only when rebuilding after a successful
      // compile. First build and post-failure retries auto-run
      // (write→run→fix). The in-flight tool call is still
      // `input-available`, so `lastBuildCompileSucceeded` skips it and
      // reads the prior completed build since the last user message.
      const lastBuildOk = lastCadMutationCompileSucceeded(liveMessages);
      if (
        cadToolName === 'build_parametric_model' &&
        requireBuildApprovalRef.current &&
        lastBuildOk === true &&
        !approvedBuildToolCallIdsRef.current.has(toolCall.toolCallId)
      ) {
        markBuildApprovalPending(toolCall.toolCallId);
        return;
      }
      clearBuildApprovalPending(toolCall.toolCallId);

      // Build the next parts array for `assistant`, replacing the
      // matching tool part with `replacement` and normalising any
      // streaming reasoning/text to `done` (some providers skip the
      // closing chunk; persisting an intermediate snapshot leaves the
      // UI showing "Thinking..." on refresh).
      const buildNextParts = (
        replacement: AppUIMessage['parts'][number],
      ): AppUIMessage['parts'] | null => {
        if (!assistant) return null;
        return assistant.parts.map((existing) => {
          if (
            existing.type === cadToolType &&
            existing.toolCallId === toolCall.toolCallId
          ) {
            // Carry forward `callProviderMetadata` from the model-emitted
            // tool-call (Gemini 3 stashes its `thoughtSignature` there).
            // Without it the next server-side turn echoes the functionCall
            // back to Gemini without a signature and Gemini rejects the
            // request with "Function call is missing a thought_signature".
            return existing.callProviderMetadata
              ? {
                  ...replacement,
                  callProviderMetadata: existing.callProviderMetadata,
                }
              : replacement;
          }
          if (
            (existing.type === 'reasoning' || existing.type === 'text') &&
            existing.state === 'streaming'
          ) {
            return { ...existing, state: 'done' as const };
          }
          return existing;
        }) as AppUIMessage['parts'];
      };

      // Always finish the tool — both in memory (spinner clears, SDK
      // can auto-continue) and on disk (refresh doesn't resurrect the
      // stuck `input-available` state, which would break every
      // subsequent send because the server can't continue a
      // conversation with an unresolved tool call).
      //
      // Persist BEFORE `addToolOutput` — same ordering as the success path.
      // `addToolOutput` is what triggers `sendAutomaticallyWhen`, and the
      // server continues from the DB branch, so the resolved (error) parts
      // must be on disk before the resubmit can fire. A compile error SHOULD
      // auto-continue (the model fixes it), so we don't pause here on a failed
      // persist; the server-side sanitizer backstops a stale read.
      //
      // MVP 2.1: prefer structured `output-available` + status:'error' so
      // server `toModelOutput` can emit explicit ErrorGuidance fields.
      const finishWithStructuredOutput = async (
        output: ParametricCompileOutput,
      ) => {
        const part = (
          cadToolName === 'build_parametric_model'
            ? {
                type: 'tool-build_parametric_model',
                toolCallId: toolCall.toolCallId,
                state: 'output-available',
                input: toolCall.input,
                output,
              }
            : {
                type: 'tool-patch_parametric_components',
                toolCallId: toolCall.toolCallId,
                state: 'output-available',
                input: toolCall.input,
                output,
              }
        ) as AppUIMessage['parts'][number];
        const nextParts = buildNextParts(part);
        if (assistant && nextParts) {
          try {
            await onToolOutput(assistant.id, nextParts);
          } catch (persistError) {
            console.warn('Failed to persist tool output to DB:', persistError);
          }
        }
        if (cadToolName === 'build_parametric_model') {
          chat.addToolOutput({
            tool: 'build_parametric_model',
            toolCallId: toolCall.toolCallId,
            output,
          });
        } else {
          chat.addToolOutput({
            tool: 'patch_parametric_components',
            toolCallId: toolCall.toolCallId,
            output,
          });
        }
      };

      const finishWithError = async (errorText: string) => {
        await finishWithStructuredOutput(buildContractFailureOutput(errorText));
      };

      let input: ParametricArtifact | null = null;
      let patchExecution:
        | {
            baseArtifact: ParametricArtifact;
            baseModelRevision: string;
            changedSectionChanges: AssemblySectionChange[];
            patchImpact: AssemblyPatchImpact;
            affectedComponentIds: string[];
          }
        | undefined;
      let baseSnapshotForProtectedRebuild: ReturnType<
        typeof latestSuccessfulModelSnapshot
      >;
      if (cadToolName === 'patch_parametric_components') {
        const patch = patchParametricComponentsSchema.safeParse(toolCall.input);
        if (!patch.success) {
          await finishWithError(
            'CAD patch input did not match the local-patch contract.',
          );
          return;
        }
        const baseSnapshot = latestSuccessfulModelSnapshot(sourceMessages);
        if (!baseSnapshot) {
          await finishWithError(
            'No successful model snapshot is available for this patch. Use build_parametric_model.',
          );
          return;
        }
        if (patch.data.base_model_revision !== baseSnapshot.modelRevision) {
          await finishWithError(
            `Patch version conflict: expected ${baseSnapshot.modelRevision}, received ${patch.data.base_model_revision}. Rebuild the Local Patch Workset from the current model.`,
          );
          return;
        }
        const base = resolveParametricArtifactRevision(
          sourceMessages,
          baseSnapshot.modelRevision,
        );
        if (!base.ok) {
          await finishWithError(
            `Could not restore the patch base: ${base.reason}`,
          );
          return;
        }
        const merged = mergeParametricComponentPatch({
          baseArtifact: base.artifact,
          baseSnapshot,
          patchInput: patch.data,
        });
        if (!merged.ok) {
          await finishWithError(`Local patch rejected: ${merged.reason}`);
          return;
        }
        input = merged.artifact;
        patchExecution = {
          baseArtifact: base.artifact,
          baseModelRevision: baseSnapshot.modelRevision,
          changedSectionChanges: merged.changedSectionChanges,
          patchImpact: merged.patchImpact,
          affectedComponentIds: merged.affectedComponentIds,
        };
      } else {
        input = isParametricArtifact(toolCall.input) ? toolCall.input : null;
        if (input)
          input = { ...input, title: modelTitle(input.title) || 'Model' };
        if (input?.protected_rebuild) {
          const baseSnapshot = latestSuccessfulModelSnapshot(sourceMessages);
          if (!baseSnapshot) {
            await finishWithError(
              'Protected rebuild requires a successful current model snapshot.',
            );
            return;
          }
          if (
            input.protected_rebuild.base_model_revision !==
            baseSnapshot.modelRevision
          ) {
            await finishWithError(
              `Protected rebuild version conflict: expected ${baseSnapshot.modelRevision}, received ${input.protected_rebuild.base_model_revision}.`,
            );
            return;
          }
          const base = resolveParametricArtifactRevision(
            sourceMessages,
            baseSnapshot.modelRevision,
          );
          if (!base.ok) {
            await finishWithError(
              `Could not restore the protected-rebuild base: ${base.reason}`,
            );
            return;
          }
          const sourceIssues = validateProtectedRebuildSource({
            baseArtifact: base.artifact,
            baseSnapshot,
            nextArtifact: input,
            contract: input.protected_rebuild,
          });
          if (sourceIssues.length > 0) {
            await finishWithError(
              [
                'Protected rebuild source validation failed:',
                ...sourceIssues,
              ].join('\n'),
            );
            return;
          }
          baseSnapshotForProtectedRebuild = baseSnapshot;
        }
      }

      if (!input) {
        await finishWithError(
          'CAD tool input was not a valid SimpleCADAPI artifact.',
        );
        return;
      }

      const artifactKind = input.artifact_kind ?? 'model';
      if (artifactKind === 'assembly') {
        const layout = validateAssemblySourceLayout(input.code);
        if (!layout.ok) {
          await finishWithError(
            [
              'Assembly source-layout contract failure:',
              ...layout.issues,
              ASSEMBLY_SOURCE_LAYOUT_GUIDANCE,
              'Resubmit one complete Assembly script. Do not change to model just to bypass this requirement.',
            ].join('\n'),
          );
          return;
        }
      }

      try {
        const nextArtifactVersion = assistant
          ? buildAssemblySuccessfulArtifactVersion({
              model_revision: `${assistant.id}:${toolCall.toolCallId}`,
              source_code: input.code,
            })
          : null;
        let runResult: RunCodeResult;
        let meshHandoff: {
          dirtyPartIds: string[] | null;
          removedPartIds: string[];
          affectedComponentIds: string[];
        } = {
          dirtyPartIds: null,
          removedPartIds: [],
          affectedComponentIds: [],
        };
        let sectionExecutionDiagnostic:
          | {
              changed_section_keys: string[];
              planned_mode: 'partial' | 'full';
              planned_section_keys: string[];
              planned_affected_part_ids: string[] | null;
            }
          | undefined;
        if (patchExecution && nextArtifactVersion) {
          const analysis = await analyzeSimpleCadAssemblySections(input.code);
          const plan = planAssemblySectionExecution({
            next_source: input.code,
            analysis,
            change: {
              kind: 'sections',
              section_changes: patchExecution.changedSectionChanges,
            },
            previous_successful_artifact_version:
              buildAssemblySuccessfulArtifactVersion({
                model_revision: patchExecution.baseModelRevision,
                source_code: patchExecution.baseArtifact.code,
              }),
            next_artifact_version: nextArtifactVersion,
          });
          sectionExecutionDiagnostic = {
            changed_section_keys: patchExecution.changedSectionChanges.map(
              (change) => `${change.operation}:${change.sectionKey}`,
            ),
            planned_mode: plan.mode,
            planned_section_keys:
              plan.mode === 'partial'
                ? plan.sections_to_execute.map(
                    (section) => `${section.kind}/${section.id}`,
                  )
                : [],
            planned_affected_part_ids:
              plan.mode === 'partial' ? plan.affected_part_ids : null,
          };
          if (plan.mode === 'partial') {
            meshHandoff = {
              dirtyPartIds: patchExecution.patchImpact.dirtyPartIds,
              removedPartIds: patchExecution.patchImpact.removedPartIds,
              affectedComponentIds: patchExecution.affectedComponentIds,
            };
            runResult = await runSimpleCadAssemblySections(
              input.code,
              conversation.id,
              plan,
            );
          } else {
            runResult = await runSimpleCadCode(
              input.code,
              conversation.id,
              nextArtifactVersion,
            );
          }
          console.info('[assembly-section-execution]', {
            ...sectionExecutionDiagnostic,
            execution_mode:
              'execution_mode' in runResult ? runResult.execution_mode : 'full',
            fallback_reason:
              'fallback_reason' in runResult ? runResult.fallback_reason : null,
            partial_failure_detail:
              'partial_failure_detail' in runResult &&
              typeof runResult.partial_failure_detail === 'string'
                ? runResult.partial_failure_detail
                : null,
          });
        } else {
          // A complete script may add or remove any Python names, so it must
          // start from a clean Worker namespace.
          await reopenSimpleCadSession(conversation.id);
          runResult = await runSimpleCadCode(input.code, conversation.id);
        }

        if (!runResult.ok) {
          await finishWithStructuredOutput(buildRunFailureOutput(runResult));
          return;
        }

        if (!hasResultShape(runResult.shapes)) {
          await finishWithStructuredOutput(
            buildContractFailureOutput(
              [
                `Contract failure: execution succeeded but top-level \`${RESULT_SHAPE_NAME}\` was not found in shapes.`,
                `shapes=${JSON.stringify(runResult.shapes)}`,
                `Assign the final ${input.artifact_kind === 'assembly' ? 'Assembly' : 'Solid or Compound'} to a variable named \`${RESULT_SHAPE_NAME}\` and resubmit a complete script starting with \`import simplecadapi as scad\`.`,
              ].join('\n'),
              runResult.shapes,
            ),
          );
          return;
        }
        let assemblyStructure: RunCodeResult['assembly'] = null;
        const mateNotes = input.mate_notes ?? [];
        if (
          artifactKind === 'assembly' &&
          runResult.result_type !== 'Assembly'
        ) {
          await finishWithStructuredOutput(
            buildContractFailureOutput(
              [
                'Contract failure: artifact_kind=assembly requires result to be Assembly.',
                `actual_result_type=${runResult.result_type ?? 'none'}`,
                'Resubmit one complete script with the matching artifact_kind and top-level result type.',
              ].join('\n'),
              runResult.shapes,
            ),
          );
          return;
        }
        if (artifactKind === 'assembly') {
          const assembly = runResult.assembly;
          const violations = validateV1AssemblyStructure(assembly);
          if (assembly) {
            violations.push(
              ...validateV1MateNotes(
                mateNotes,
                new Set(
                  assembly.components.map(
                    (component) => component.component_id,
                  ),
                ),
              ),
            );
            if (input.protected_rebuild && baseSnapshotForProtectedRebuild) {
              violations.push(
                ...validateProtectedRebuildRuntime({
                  baseSnapshot: baseSnapshotForProtectedRebuild,
                  nextComponents: assembly.components,
                  contract: input.protected_rebuild,
                }),
              );
            }
          }
          if (violations.length > 0) {
            await finishWithStructuredOutput(
              buildContractFailureOutput(
                ['Assembly structure contract failure:', ...violations].join(
                  '\n',
                ),
                runResult.shapes,
              ),
            );
            return;
          }
          assemblyStructure = assembly;
        }
        if (
          artifactKind === 'model' &&
          runResult.result_type !== 'Solid' &&
          runResult.result_type !== 'Compound'
        ) {
          await finishWithStructuredOutput(
            buildContractFailureOutput(
              [
                'Contract failure: artifact_kind=model requires result to be Solid or Compound.',
                `actual_result_type=${runResult.result_type ?? 'none'}`,
                'Resubmit one complete script with the matching artifact_kind and top-level result type.',
              ].join('\n'),
              runResult.shapes,
            ),
          );
          return;
        }
        let geometry:
          | {
              volume: number;
              bbox: {
                min: [number, number, number];
                max: [number, number, number];
              };
            }
          | undefined;
        if (artifactKind === 'model') {
          try {
            const g = await inspectSimpleCadGeometry(conversation.id);
            if (g.ok && g.volume != null && g.bbox != null) {
              geometry = { volume: g.volume, bbox: g.bbox };
            }
          } catch (e) {
            console.warn('inspect_geometry failed:', e);
          }
        }
        // render_mesh projects an Assembly to a temporary Compound without
        // replacing result, so both product modes use this seven-view path.
        let imageAttached = false;
        try {
          const previewBlob = await renderResultInspectionBlob(conversation.id);
          // Same path used by MessageBubble and history: `preview-{toolCallId}`.
          const previewPath = `${conversation.user_id}/${conversation.id}/preview-${toolCall.toolCallId}`;
          const { error: uploadError } = await supabase.storage
            .from('images')
            .upload(previewPath, previewBlob, {
              contentType: 'image/png',
              upsert: true,
            });
          if (uploadError) {
            console.warn(
              'SimpleCADAPI inspection preview upload failed:',
              uploadError,
            );
          } else {
            imageAttached = true;
          }
        } catch (previewError) {
          console.warn('SimpleCADAPI seven-view render failed:', previewError);
        }

        const output: ParametricCompileOutput =
          artifactKind === 'assembly'
            ? {
                status: 'success',
                artifact_kind: artifactKind,
                result_type: 'Assembly',
                shapes: runResult.shapes,
                assembly: assemblyStructure
                  ? {
                      assembly_id: assemblyStructure.assembly_id,
                      name: assemblyStructure.name,
                    }
                  : undefined,
                components: assemblyStructure?.components,
                bom: assemblyStructure?.bom,
                mate_notes: mateNotes,
                assembly_step: { available: true },
                inspection: {
                  views: [...DEFAULT_INSPECTION_VIEW_LABELS],
                  imageAttached,
                },
                message: [
                  `Assembly execution successful. Final shape handle: \`${RESULT_SHAPE_NAME}\`.`,
                  `components=${assemblyStructure?.components.length ?? 0}; bom=${JSON.stringify(assemblyStructure?.bom ?? [])}`,
                  'Assembly STEP download is available from the Parameters panel. STL is intentionally unavailable because it cannot preserve the component structure.',
                  imageAttached
                    ? 'A labeled seven-view inspection sheet is attached from a temporary Compound preview. Inspect every view against the user request, then rebuild the complete Assembly if anything is wrong.'
                    : 'The Assembly compiled, but its seven-view inspection image could not be attached. Review the complete Assembly script before finalizing.',
                ].join(' '),
              }
            : {
                status: 'success',
                artifact_kind: artifactKind,
                result_type: runResult.result_type as 'Solid' | 'Compound',
                shapes: runResult.shapes,
                geometry,
                inspection: {
                  views: [...DEFAULT_INSPECTION_VIEW_LABELS],
                  imageAttached,
                },
                message: [
                  `Execution successful (Pyodide + OCP.wasm). Final shape handle: \`${RESULT_SHAPE_NAME}\`.`,
                  `shapes=${JSON.stringify(runResult.shapes)}`,
                  'STEP/STL download is available from the Parameters panel (STEP preferred).',
                  geometry
                    ? `Geometry: volume=${geometry.volume}; bbox min=(${geometry.bbox.min.join(',')}); max=(${geometry.bbox.max.join(',')}).`
                    : 'Geometry facts: unavailable (inspect_geometry failed or skipped).',
                  imageAttached
                    ? 'A labeled seven-view inspection sheet is attached (ISO, FRONT, BACK, LEFT, RIGHT, TOP, BOTTOM). You MUST inspect every view against the user request — and against any user reference image(s) still in this conversation as the true visual target (shape/silhouette from the original reference image(s); do not divert attention to a vision feature-summary block during this review) — list all defects, then resubmit one complete corrected script if anything is wrong — do not finalize on compile success alone, and do not patch incrementally in chat text.'
                    : 'Seven-view inspection image could not be attached. Review the SimpleCADAPI script carefully against the user request and any user reference image(s) in this conversation as the true visual target (do not divert attention to a vision feature-summary block); if anything may be missing or wrong, call build_parametric_model again with a complete corrected script.',
                  'If all seven views satisfy the request, give a concise final response via answer_user.',
                ].join(' '),
              };

        if (assistant) {
          lastAutoAppliedPreviewKeyRef.current = `artifact:${assistant.id}:${input.code.length}`;
          onViewArtifact(input, assistant.id, assemblyStructure?.components, {
            modelRevision: `${assistant.id}:${toolCall.toolCallId}`,
            ...meshHandoff,
          });
        }

        const successPart = (
          cadToolName === 'build_parametric_model'
            ? {
                type: 'tool-build_parametric_model',
                toolCallId: toolCall.toolCallId,
                state: 'output-available',
                input,
                output,
              }
            : {
                type: 'tool-patch_parametric_components',
                toolCallId: toolCall.toolCallId,
                state: 'output-available',
                input: toolCall.input,
                output,
              }
        ) as AppUIMessage['parts'][number];
        const nextParts = buildNextParts(successPart);

        if (nextParts && assistant) {
          try {
            const priorChanges = recentSuccessfulModelChanges(liveMessages);
            const currentChange = input.planned_changes?.trim();
            const snapshot = createParametricModelSnapshot({
              messageId: assistant.id,
              toolCallId: toolCall.toolCallId,
              artifact: input,
              parameters: parseParameters(input.code),
              components: assemblyStructure?.components,
              bom: assemblyStructure?.bom,
              mateNotes,
              recentChanges: currentChange
                ? [currentChange, ...priorChanges]
                : priorChanges,
            });
            await onToolOutput(assistant.id, nextParts, {
              ...assistant.metadata,
              modelSnapshot: snapshot,
            });
          } catch (persistError) {
            console.warn('Failed to persist tool output to DB:', persistError);
            // The server continues from the DB branch. If this build's output
            // never landed, auto-resubmitting would run against a stale branch
            // and discard a model the user can already see. Pause the loop and
            // let them retry.
            persistFailedRef.current = true;
            toast({
              title: "Couldn't save this step",
              description:
                "The model is shown but the build wasn't saved, so Iris paused. Please retry.",
              variant: 'destructive',
            });
          }
        }

        if (
          !persistFailedRef.current &&
          cadToolName === 'build_parametric_model'
        ) {
          const current = queryClient.getQueryData<Conversation>([
            'conversation',
            conversation.id,
          ]);
          const oldTitle = current?.title ?? conversation.title;
          if (DEFAULT_CONVERSATION_TITLES.includes(oldTitle)) {
            try {
              const title = modelTitle(input.title) || 'Model';
              // Compare-and-set protects a concurrent manual rename.
              const { data, error } = await supabase
                .from('conversations')
                .update({ title })
                .eq('id', conversation.id)
                .eq('title', oldTitle)
                .select('title')
                .maybeSingle();
              if (error) throw error;
              if (data) {
                queryClient.setQueryData(
                  ['conversation', conversation.id],
                  (old: Conversation | undefined) =>
                    old ? { ...old, title: data.title } : old,
                );
                void queryClient.invalidateQueries({
                  queryKey: ['conversations'],
                });
              }
            } catch (error) {
              console.warn(
                'Could not name the conversation after the model:',
                error,
              );
            }
          }
        }

        if (cadToolName === 'build_parametric_model') {
          chat.addToolOutput({
            tool: 'build_parametric_model',
            toolCallId: toolCall.toolCallId,
            output,
          });
        } else {
          chat.addToolOutput({
            tool: 'patch_parametric_components',
            toolCallId: toolCall.toolCallId,
            output,
          });
        }
      } catch (error) {
        await finishWithStructuredOutput(
          buildContractFailureOutput(
            `SimpleCADAPI worker failed:\n${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    },
    [
      clearBuildApprovalPending,
      conversation.id,
      conversation.title,
      conversation.user_id,
      dbMessages,
      markBuildApprovalPending,
      onToolOutput,
      onViewArtifact,
      queryClient,
      toast,
    ],
  );

  const handleApproveBuild = useCallback(
    async (toolCallId: string, guidance?: string) => {
      const trimmedGuidance = guidance?.trim() ?? '';
      clearBuildApprovalPending(toolCallId);

      const chat = chatRef.current;
      if (!chat) return;

      const msgs =
        (chat.messages as AppUIMessage[] | undefined) ?? messagesRef.current;

      if (!trimmedGuidance) {
        approvedBuildToolCallIdsRef.current.add(toolCallId);
        let input: unknown;
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (
              part.type === 'tool-build_parametric_model' &&
              'toolCallId' in part &&
              part.toolCallId === toolCallId
            ) {
              input = 'input' in part ? part.input : undefined;
            }
          }
        }
        void handleToolCall({
          toolCall: {
            toolName: 'build_parametric_model',
            toolCallId,
            input,
          },
        });
        return;
      }

      // G3: skip worker; resolve the dangling tool call and put guidance in
      // the tool output so auto-continue asks the model to rewrite.
      const findAssistant = (list: readonly AppUIMessage[]) =>
        list.find(
          (msg) =>
            msg.role === 'assistant' &&
            msg.parts.some(
              (p) =>
                p.type === 'tool-build_parametric_model' &&
                'toolCallId' in p &&
                p.toolCallId === toolCallId,
            ),
        );
      const assistant =
        findAssistant(chat.messages as AppUIMessage[]) ?? findAssistant(msgs);
      if (!assistant) {
        toast({
          title: 'Could not apply guidance',
          description: 'The pending build tool call was not found.',
          variant: 'destructive',
        });
        return;
      }

      let toolInput: unknown;
      const existingTool = assistant.parts.find(
        (p) =>
          p.type === 'tool-build_parametric_model' &&
          'toolCallId' in p &&
          p.toolCallId === toolCallId,
      );
      if (existingTool && 'input' in existingTool) {
        toolInput = existingTool.input;
      }

      const output = buildUserGuidanceSkipOutput(trimmedGuidance);
      const replacement = {
        type: 'tool-build_parametric_model',
        toolCallId,
        state: 'output-available',
        input: toolInput,
        output,
      } as AppUIMessage['parts'][number];

      const nextParts = assistant.parts.map((existing) => {
        if (
          existing.type === 'tool-build_parametric_model' &&
          existing.toolCallId === toolCallId
        ) {
          return existing.callProviderMetadata
            ? {
                ...replacement,
                callProviderMetadata: existing.callProviderMetadata,
              }
            : replacement;
        }
        if (
          (existing.type === 'reasoning' || existing.type === 'text') &&
          existing.state === 'streaming'
        ) {
          return { ...existing, state: 'done' as const };
        }
        return existing;
      }) as AppUIMessage['parts'];

      try {
        await onToolOutput(assistant.id, nextParts);
      } catch (persistError) {
        console.warn(
          'Failed to persist guidance-skip tool output to DB:',
          persistError,
        );
        toast({
          title: "Couldn't save guidance",
          description: 'Iris may not see your note. Please try again.',
          variant: 'destructive',
        });
        return;
      }

      chat.addToolOutput({
        tool: 'build_parametric_model',
        toolCallId,
        output,
      });
    },
    [clearBuildApprovalPending, handleToolCall, onToolOutput, toast],
  );

  // ───────────────────────────────────────────────────────────────────────
  // Chat instance — keyed by conversation.id via `useCachedAiChat` so that
  // switching conversations reuses cached instances (or creates one), but
  // the Chat for THIS conversation is stable across re-renders.
  // ───────────────────────────────────────────────────────────────────────
  const chat = useCachedAiChat({
    id: conversation.id,
    messages: initialBranch,
    transport,
    onToolCall: handleToolCall,
    // Pause the loop if a tool-output persist failed — resubmitting would run
    // the server against a stale DB branch (see `persistFailedRef`).
    // Parametric: soft cap stops after a successful build; failed builds may
    // continue past the soft cap until success or the hard cap.
    sendAutomaticallyWhen: (ctx) => {
      if (persistFailedRef.current) return false;
      if (!lastAssistantMessageIsCompleteWithParametricMutation(ctx)) {
        return false;
      }

      const rounds = countCadMutationRoundsSinceLastUser(ctx.messages);
      const lastOk = lastCadMutationCompileSucceeded(ctx.messages);
      const lastUserIndex = lastUserMessageIndex(ctx.messages);
      const toastKeyBase =
        lastUserIndex >= 0
          ? (ctx.messages[lastUserIndex]?.id ?? 'anon')
          : 'anon';

      if (rounds >= hardMaxRounds) {
        const hardKey = `${toastKeyBase}:hard`;
        if (buildCapToastKeyRef.current !== hardKey) {
          buildCapToastKeyRef.current = hardKey;
          toast({
            title: 'Generation paused',
            description:
              'Multiple builds still could not run. Modify the request or start a new chat.',
            variant: 'destructive',
          });
        }
        return false;
      }

      if (rounds >= softMaxRounds) {
        if (lastOk === true) {
          const softKey = `${toastKeyBase}:soft`;
          if (buildCapToastKeyRef.current !== softKey) {
            buildCapToastKeyRef.current = softKey;
            toast({
              title: 'Build limit reached',
              description:
                'The current runnable model is kept for preview. Review it, then send more feedback to continue building.',
            });
          }
          return false;
        }
        // Failed compile: keep auto-continuing past the soft cap.
        return lastOk === false;
      }

      return true;
    },
    // Out-of-band conversation-level signals (title + suggestions) arrive
    // here as transient data parts — they never land in `messages.parts`,
    // so we patch the conversation query cache directly. See
    // `emitConversationTitle` / `emitConversationSuggestions` in
    // `src/server/aiChat.ts` for the producers.
    onData: (part) => {
      // The SDK's `ChatOnDataCallback` widens `data` to `unknown` even
      // though we typed `AppDataTypes` — `InferUIMessageData` doesn't
      // preserve the per-key mapping through the generic. Narrow
      // ourselves: discriminate on `type`, cast `data` to the
      // corresponding `AppDataTypes` entry. The producer side
      // (`writer.write({ type, data })`) is the type-checked counterpart.
      if (part.type === 'data-title-update') {
        const { title } = part.data as ConversationTitleUpdate;
        queryClient.setQueryData(
          ['conversation', conversation.id],
          (old: Conversation | undefined) => (old ? { ...old, title } : old),
        );
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
        return;
      }
      if (part.type === 'data-suggestions-update') {
        const { suggestions } = part.data as ConversationSuggestionsUpdate;
        queryClient.setQueryData(
          ['conversation', conversation.id],
          (old: Conversation | undefined) =>
            old
              ? {
                  ...old,
                  settings: {
                    ...(old.settings && typeof old.settings === 'object'
                      ? old.settings
                      : {}),
                    suggestions,
                  },
                }
              : old,
        );
      }
    },
    onFinish: ({ message }) => {
      setShowCleanSessionRecovery(false);
      // The DB trigger has already advanced `current_message_leaf_id` to
      // the new assistant. Push that into the conversation cache
      // optimistically so the UI doesn't flicker; the invalidation right
      // after re-confirms against the server.
      if (message?.id) {
        queryClient.setQueryData(
          ['conversation', conversation.id],
          (old: Conversation | undefined) =>
            old ? { ...old, current_message_leaf_id: message.id } : old,
        );
      }
      queryClient.invalidateQueries({
        queryKey: ['messages', conversation.id],
      });
      queryClient.invalidateQueries({
        queryKey: ['conversation', conversation.id],
      });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['billing', 'status'] });
    },
    onError: (error) => {
      console.error('[chat]', error);
      // 402 is already surfaced by `billingAwareFetch` above with a
      // tailored message — don't show a generic toast on top of it.
      if (billingErrorHandledRef.current) {
        billingErrorHandledRef.current = false;
        return;
      }
      if (findLatestPreview(messagesRef.current)?.type === 'artifact') {
        setShowCleanSessionRecovery(true);
      }
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Iris ran into a problem',
        description: message || 'The model call failed. Please try again.',
        variant: 'destructive',
      });
    },
  });

  const { messages, status, stop, sendMessage, regenerate, setMessages } =
    useChat<AppUIMessage>({ chat });

  // Keep the refs in sync for callbacks that were baked at Chat-init time
  // (`onToolCall`) — those captured `messages` at mount otherwise.
  useEffect(() => {
    chatRef.current = chat;
    messagesRef.current = messages;
  }, [chat, messages]);

  // Load-time recovery for tool parts that never finished in a previous
  // session. If the last assistant in DB has a `tool-build_parametric_model`
  // stuck at `input-streaming` / `input-available`, the UI shows a perma-
  // spinner AND every subsequent send 500s because the server can't
  // continue a conversation with an unresolved tool call. Rewrite to
  // `output-error` so the chat is in a valid state — the user can retry
  // or send a new message. Use setMessages (not addToolOutput) so we
  // don't trigger an unwanted auto-resubmit on load.
  const recoveredChatRef = useRef<unknown>(null);
  useEffect(() => {
    if (recoveredChatRef.current === chat) return;
    recoveredChatRef.current = chat;

    // `chat.status` is read once per chat+mount on purpose: a cached Chat
    // that is mid-generation when ChatSession (re)mounts is not "stuck from
    // a previous session", and collectStuckToolRecovery skips it entirely.
    //
    // The scan is structurally typed (dependency-free for its unit tests),
    // so its map comes back as `RecoveryPartLike[]` values. Every rewrite
    // spreads the original part and only narrows tool/text `state`, so
    // re-narrowing to our part union is sound — this is the one place the
    // structural boundary is crossed.
    const stuckByMessageId = collectStuckToolRecovery({
      status: chat.status,
      messages: chat.messages,
      preserveToolCallIds: pendingBuildApprovalsFor(conversation.id),
    }) as Map<string, AppUIMessage['parts']>;

    if (stuckByMessageId.size === 0) return;

    setMessages(
      (chat.messages as AppUIMessage[]).map((msg) =>
        stuckByMessageId.has(msg.id)
          ? { ...msg, parts: stuckByMessageId.get(msg.id)! }
          : msg,
      ),
    );

    for (const [messageId, nextParts] of stuckByMessageId) {
      void onToolOutput(messageId, nextParts).catch((err) => {
        if (err instanceof AssistantRowMissingError) {
          // The interruption happened before the server's `onFinish` INSERT,
          // so this assistant exists only in the cached in-memory chat. The
          // DB branch (leaf = the user message) has no dangling tool call to
          // repair, and the setMessages above already fixed the UI.
          console.info(
            'Stuck-tool recovery: assistant row was never persisted; ' +
              'nothing to repair in DB (benign).',
          );
          return;
        }
        console.warn('Failed to persist stuck-tool recovery:', err);
      });
    }
  }, [chat, conversation.id, onToolOutput, setMessages]);

  const isLoading = status === 'submitted' || status === 'streaming';

  useReportAgentActivity(conversation.id, isLoading);

  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);

  // ───────────────────────────────────────────────────────────────────────
  // Sibling tree for branch nav.
  //
  // The tree merges DB rows (authoritative `parent_message_id` + persisted
  // columns) with live `chat.messages` (streaming `parts` and any not-yet-
  // persisted bubbles). For messages we've seen in DB, the merge takes the
  // DB row's parent + rating/etc. and overlays the SDK's live parts. For
  // chat-only messages (streaming user/assistant before the refetch lands)
  // the parent is derived from chat order — they're a linear branch by
  // definition.
  // ───────────────────────────────────────────────────────────────────────
  const treeMessages = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const row of dbMessages) {
      byId.set(row.id, messageRowToChatMessage(row));
    }
    for (let i = 0; i < messages.length; i += 1) {
      const live = messages[i];
      const existing = byId.get(live.id);
      if (existing) {
        byId.set(live.id, {
          ...existing,
          parts: live.parts,
          metadata: live.metadata,
        });
      } else {
        const parent = i === 0 ? null : messages[i - 1].id;
        byId.set(live.id, {
          ...live,
          parent_message_id: parent,
          conversation_id: conversation.id,
        });
      }
    }
    return Array.from(byId.values());
  }, [dbMessages, messages, conversation.id]);

  const messageTree = useMemo(() => new Tree(treeMessages), [treeMessages]);
  const branchNodes = useMemo(
    () =>
      messages
        .map((m) => messageTree.allNodes.get(m.id))
        .filter((node): node is NonNullable<typeof node> => !!node),
    [messages, messageTree],
  );

  // ───────────────────────────────────────────────────────────────────────
  // Auto-switch the preview pane to the freshest assistant output.
  //
  // Tracks the last preview key we've fired so clicking an OLD artifact's
  // Eye button doesn't get clobbered by a delayed auto-switch on the next
  // render. Only triggers when a genuinely new preview appears (key
  // changes) — not for every state tick.
  // ───────────────────────────────────────────────────────────────────────
  const lastAutoAppliedPreviewKeyRef = useRef<string | null>(null);
  const historicalArtifactsByMessageId = useMemo(() => {
    const artifacts = new Map<string, ParametricArtifact>();
    for (const message of messages) {
      const revision =
        message.metadata?.modelSnapshot?.modelRevision ??
        successfulCadRevisionForMessage(message);
      if (!revision) continue;
      const resolved = resolveParametricArtifactRevision(messages, revision);
      if (resolved.ok) artifacts.set(message.id, resolved.artifact);
    }
    return artifacts;
  }, [messages]);
  useEffect(() => {
    const preview = findLatestPreview(messages);
    if (!preview) return;
    const key = `artifact:${preview.messageId}:${preview.artifact.code.length}`;
    if (lastAutoAppliedPreviewKeyRef.current === key) return;
    lastAutoAppliedPreviewKeyRef.current = key;
    onViewArtifact(preview.artifact, preview.messageId);
  }, [messages, onViewArtifact]);

  // ───────────────────────────────────────────────────────────────────────
  // Action handlers. Pattern: await the parent's DB write, then call the
  // matching `chat.*` method. Each handler lives next to the operation
  // that justifies its `chat.setMessages` / `chat.sendMessage` /
  // `chat.regenerate` — no auto-sync effect, no prop watching.
  // ───────────────────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (parts: AppUIMessage['parts']) => {
      setShowCleanSessionRecovery(false);
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const imageCount = parts.filter(
        (p) => p.type === 'file' && p.mediaType.startsWith('image/'),
      ).length;
      const meshCount = parts.filter(
        (p) => p.type === 'data-mesh-context',
      ).length;
      posthog.capture('message_sent', {
        type: 'parametric',
        model_name: model,
        text,
        image_count: imageCount,
        mesh_count: meshCount,
        conversation_id: conversation.id,
      });

      const { userMessageId } = await onSendParts(parts);
      // The transport closes over `model` at the time the Chat instance was
      // created (which might be `PromptView`'s `model` for first-turn
      // conversations created from the landing page). Always pass the
      // current model in the per-call body so the transport's
      // `...(body ?? {})` spread overrides any stale baked-in value.
      await sendMessage(
        { id: userMessageId, parts, metadata: { model } },
        { body: { model } },
      );
    },
    [conversation.id, model, onSendParts, sendMessage],
  );

  const handleStartCleanSession = useCallback(async () => {
    if (isStartingCleanSession) return;
    setIsStartingCleanSession(true);
    try {
      const seed = await loadParametricSeedFromConversation({
        conversationId: conversation.id,
        leafId: conversation.current_message_leaf_id,
      });
      const conversationId = await createConversationFromParametricSeed({
        userId: conversation.user_id,
        model,
        title: conversation.title,
        seed,
        origin: {
          kind: 'recovery',
          sourceConversationId: conversation.id,
          sourceModelRevision: seed.sourceModelRevision,
          sourceTitle: conversation.title,
        },
      });
      setShowCleanSessionRecovery(false);
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate({ to: '/editor/$id', params: { id: conversationId } });
    } catch (error) {
      toast({
        title: 'Could not start a clean session',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsStartingCleanSession(false);
    }
  }, [
    conversation.current_message_leaf_id,
    conversation.id,
    conversation.title,
    conversation.user_id,
    isStartingCleanSession,
    model,
    navigate,
    queryClient,
    toast,
  ]);

  const handleEditUserText = useCallback(
    async (original: ChatMessage, text: string) => {
      const parts: AppUIMessage['parts'] = [{ type: 'text', text }];
      const { newUserMessageId, parentPath } = await onEdit(original, parts);
      setMessages(parentPath);
      await sendMessage(
        { id: newUserMessageId, parts, metadata: { model } },
        { body: { model } },
      );
    },
    [model, onEdit, sendMessage, setMessages],
  );

  const handleRetry = useCallback(
    async (assistant: ChatMessage, nextModel: Model) => {
      if (nextModel !== model) setModel(nextModel);
      await onRetry(assistant);
      await regenerate({
        messageId: assistant.id,
        body: { model: nextModel },
      });
    },
    [model, onRetry, regenerate, setModel],
  );

  const handleRestore = useCallback(
    async (assistant: ChatMessage) => {
      try {
        await reopenSimpleCadSession(conversation.id);
      } catch (error) {
        console.warn('SimpleCADAPI session reopen on Restore failed:', error);
      }
      const { newBranch } = await onRestore(assistant);
      setMessages(newBranch);
    },
    [conversation.id, onRestore, setMessages],
  );

  const handleSelectLeaf = useCallback(
    async (messageId: string) => {
      await onSelectLeaf(messageId);
      setMessages(branchForLeaf(messageId));
    },
    [branchForLeaf, onSelectLeaf, setMessages],
  );

  // ───────────────────────────────────────────────────────────────────────
  // Scroll-to-bottom on new content. Reads the Radix Viewport directly so
  // the user can still scroll up to re-read older turns without us forcing
  // them back down.
  // ───────────────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector(
      '[data-radix-scroll-area-viewport]',
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [branchNodes, isLoading]);

  return (
    <>
      <ScrollArea
        className="iris-chat-scroll relative w-full min-w-0 max-w-full flex-1 self-center overflow-x-hidden px-3 py-0 md:min-h-0 md:p-4 [&_[data-radix-scroll-area-viewport]]:overflow-x-hidden"
        ref={scrollRef}
      >
        <div className="pointer-events-none sticky left-0 top-0 z-50 h-3 bg-gradient-to-b from-adam-bg-secondary-dark/90 to-transparent md:hidden" />
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 pb-6 md:gap-8 md:pb-4">
          {branchNodes.map((node, index) => {
            const isLastMessage = index === branchNodes.length - 1;
            return (
              <MessageBubble
                key={node.id}
                message={node}
                isLoading={isLoading}
                isLastMessage={isLastMessage}
                currentModel={model}
                resolvedArtifact={historicalArtifactsByMessageId.get(node.id)}
                onSelectLeaf={(id) => void handleSelectLeaf(id)}
                onEditUserText={
                  node.role === 'user' ? handleEditUserText : undefined
                }
                onViewArtifact={(artifact) => onViewArtifact(artifact, node.id)}
                pendingBuildApprovalIds={pendingBuildApprovalIds}
                onApproveBuild={handleApproveBuild}
                onChangeRating={
                  node.role === 'assistant'
                    ? (rating) => onChangeRating(node.id, rating)
                    : undefined
                }
                onRetry={
                  node.role === 'assistant'
                    ? (nextModel) => void handleRetry(node, nextModel)
                    : undefined
                }
                onRestore={
                  node.role === 'assistant' && !isLastMessage
                    ? () => void handleRestore(node)
                    : undefined
                }
              />
            );
          })}
        </div>
      </ScrollArea>

      <div className="iris-chat-composer w-full shrink-0 self-center px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-4 md:pb-4">
        {!isLoading && showCleanSessionRecovery ? (
          <div className="mx-auto mb-3 max-w-3xl rounded-lg border border-adam-neutral-700 bg-adam-neutral-900 p-3">
            <p className="mb-2 text-sm text-adam-text-secondary">
              The request failed, but your latest successful model is still
              available.
            </p>
            <Button
              type="button"
              size="sm"
              disabled={isStartingCleanSession}
              onClick={() => void handleStartCleanSession()}
            >
              {isStartingCleanSession
                ? 'Starting Clean Session...'
                : 'Start a Clean Session from This Model'}
            </Button>
          </div>
        ) : null}
        {/* Suggestions are conversation-level — the server writes them
            to `conversation.settings.suggestions` and emits a transient
            `data-suggestions-update` on each non-tool-call assistant
            turn (see `emitConversationSuggestions` in
            `src/server/aiChat.ts`). We hide them while a stream is in
            flight; the freshly-arrived pills replace the stale ones
            when streaming finishes. */}
        {/* Keep the Iris experience self-contained when the local credit
            balance reaches zero. The legacy experience retains its original
            billing prompt for backwards compatibility. */}
        {!isLoading &&
          (isDisabled ? (
            <div className="mx-auto max-w-3xl">
              <p className="py-3 text-center text-sm text-[#6e6e73]">
                Your Iris Credits are used up.
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl pt-1">
              <SuggestionPills
                suggestions={conversation.settings?.suggestions ?? []}
                onSelect={(suggestion) =>
                  void handleSend([{ type: 'text', text: suggestion }])
                }
              />
            </div>
          ))}
        <TextAreaChat
          onSubmit={(parts) => void handleSend(parts)}
          placeholder="Ask Iris to modify this model..."
          isLoading={isLoading}
          stopGenerating={stop}
          disabled={isDisabled}
          model={model}
          setModel={setModel}
          conversation={conversation}
        />
      </div>
    </>
  );
}

type LatestPreview = {
  type: 'artifact';
  messageId: string;
  artifact: ParametricArtifact;
} | null;

function findLatestPreview(messages: AppUIMessage[]): LatestPreview {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    const revision =
      message.metadata?.modelSnapshot?.modelRevision ??
      successfulCadRevisionForMessage(message);
    if (revision) {
      const resolved = resolveParametricArtifactRevision(messages, revision);
      if (resolved.ok) {
        return {
          type: 'artifact',
          messageId: message.id,
          artifact: resolved.artifact,
        };
      }
    }
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.parts[partIndex];
      if (
        part.type === 'tool-build_parametric_model' &&
        part.state !== 'input-streaming' &&
        isParametricArtifact(part.input)
      ) {
        return {
          type: 'artifact',
          messageId: message.id,
          artifact: part.input,
        };
      }
    }
  }
  return null;
}

function successfulCadRevisionForMessage(
  message: AppUIMessage,
): string | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (
      (part.type !== 'tool-build_parametric_model' &&
        part.type !== 'tool-patch_parametric_components') ||
      part.state !== 'output-available' ||
      part.output.status !== 'success'
    ) {
      continue;
    }
    return `${message.id}:${part.toolCallId}`;
  }
  return undefined;
}

function mergePersistedSourceHistory(
  persisted: readonly Message[],
  live: readonly AppUIMessage[],
): AppUIMessage[] {
  const byId = new Map<string, AppUIMessage>();
  for (const message of persisted) {
    byId.set(message.id, {
      id: message.id,
      role: message.role,
      parts: message.parts,
      metadata: message.metadata,
    });
  }
  for (const message of live) {
    const stored = byId.get(message.id);
    byId.set(message.id, {
      ...message,
      metadata: stored?.metadata ?? message.metadata,
    });
  }
  return [...byId.values()];
}

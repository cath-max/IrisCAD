import { modelFilename } from '@shared/modelNaming';
import { ChatTitle } from '@/components/chat/ChatTitle';
import { ChatSession } from '@/components/chat/ChatSession';
import { CreateIcon } from '@/components/icons/ui/CreateIcon';
import { IrisModelPanel } from '@/components/parameter/IrisModelPanel';
import { ParameterSheetContent } from '@/components/parameter/ParameterSheetContent';
import type { ParameterChangeTiming } from '@/components/parameter/parameterChangeTiming';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ShareContent } from '@/components/ui/ShareContent';
import { ThreeScene } from '@/components/viewer/ThreeScene';
import { PreviewExportControl } from '@/components/viewer/PreviewExportControl';
import Loader from '@/components/viewer/Loader';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { ConversationContext } from '@/contexts/ConversationContext';
import { SelectedItemsContext } from '@/contexts/SelectedItemsContext';
import { useConversation } from '@/contexts/ConversationContext';
import {
  ensureInputRecords,
  messageRowToChatMessage,
  type ChatMessage,
} from '@/lib/aiMessages';
import parseParameters from '@shared/parseParameters';
import {
  refreshSnapshotAssemblyVisibility,
  refreshSnapshotParameters,
} from '@shared/modelSnapshot';
import { normalizeModelId } from '@shared/models';
import { supabase } from '@/lib/supabase';
import { updateParameter } from '@/lib/utils';
import {
  persistAssistantParts,
  persistUserMessage,
  useChangeRatingMutation,
  useMessagesQuery,
} from '@/services/messageService';
import type { StepExporter } from '@/utils/downloadUtils';
import {
  buildSimpleCadBufferGeometry,
  isRenderableSimpleCadMesh,
} from '@/utils/simpleCadMeshGeometry';
import {
  buildAssemblyIncrementalMeshingStats,
  SimpleCadAssemblyIncrementalPreview,
} from '@/utils/simpleCadAssemblyIncrementalPreview';
import {
  analyzeSimpleCadAssemblySections,
  enterSimpleCadSession,
  exportResultBlob,
  hasResultShape,
  inspectSimpleCadAssemblyRenderState,
  isSimpleCadWorkerSessionLossError,
  renderSimpleCadAssemblyPartMeshes,
  renderSimpleCadMesh,
  registerSimpleCadAssemblyBaseline,
  runSimpleCadAssemblySections,
  runSimpleCadCode,
} from '@/worker/simpleCadToolWorker';
import { planAssemblySectionExecution } from '@shared/assemblySectionExecutionPlanner';
import {
  buildAssemblyRenderSnapshot,
  buildAssemblySuccessfulArtifactVersion,
  classifyAssemblyRenderChanges,
} from '@shared/assemblyIncrementalMeshingDiff';
import type { AppUIMessage } from '@shared/chatAi';
import { replaceBuildParametricModelOutput } from '@shared/parametricParts';
import Tree from '@shared/Tree';
import type {
  Conversation,
  Message,
  Model,
  Parameter,
  ParametricArtifact,
} from '@shared/types';
import type { AssemblyComponent } from '@shared/assemblyContract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Loader2, Share } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BufferGeometry, Group } from 'three';
import type { MessageItem } from '../types/misc.ts';
import { ConversationView } from './ConversationView';

/**
 * Route-level entry for `/editor/$id`.
 *
 * Owns the conversation fetch + auth gate + provider wiring. The actual
 * editor logic lives inside `<ConversationEditor>` which assumes the
 * conversation is loaded and the contexts are mounted.
 */
export default function EditorView() {
  const { id: conversationId } = useParams({
    from: '/_layout/_auth/editor/$id',
  });
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [images, setImages] = useState<MessageItem[]>([]);
  const [mesh, setMesh] = useState<MessageItem | null>(null);

  const { data: conversation, isLoading: isConversationLoading } = useQuery({
    queryKey: ['conversation', conversationId],
    enabled: !!conversationId,
    queryFn: async () => {
      if (!conversationId) throw new Error('Conversation ID is required');
      const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('id', conversationId)
        .eq('user_id', user?.id ?? '')
        .eq('type', 'parametric')
        .limit(1)
        .single();
      if (error) throw error;
      return data as Conversation;
    },
  });

  const { mutate: updateConversation, mutateAsync: updateConversationAsync } =
    useMutation({
      mutationFn: async (conversation: Conversation) => {
        const { data, error } = await supabase
          .from('conversations')
          .update(conversation)
          .eq('id', conversation.id)
          .select()
          .single()
          .overrideTypes<Conversation>();
        if (error) throw error;
        return data;
      },
      onMutate(conversation) {
        const oldConversation = queryClient.getQueryData<Conversation>([
          'conversation',
          conversation.id,
        ]);
        queryClient.setQueryData(
          ['conversation', conversation.id],
          conversation,
        );
        return { oldConversation };
      },
      onSuccess() {
        queryClient.invalidateQueries({
          queryKey: ['conversation', conversationId],
        });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      },
      onError(_error, conversation, context) {
        queryClient.setQueryData(
          ['conversation', conversation.id],
          context?.oldConversation,
        );
      },
    });

  useEffect(() => {
    if (!conversationId) navigate({ to: '/' });
  }, [conversationId, navigate]);

  if (isConversationLoading) {
    return (
      <div className="iris-editor-route-loading flex h-full w-full items-center justify-center text-adam-text-primary">
        <Loader2 className="h-10 w-10 animate-spin" />
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="iris-editor-route-loading flex h-full w-full flex-col items-center justify-center text-adam-text-primary">
        <span className="text-2xl font-medium">404</span>
        <span className="text-sm">Conversation not found</span>
      </div>
    );
  }

  return (
    <ConversationContext.Provider
      value={{ conversation, updateConversation, updateConversationAsync }}
    >
      <SelectedItemsContext.Provider
        value={{ images, setImages, mesh, setMesh }}
      >
        {/* `key` forces a full remount whenever the conversation changes,
            so all per-conversation state inside the editor (active
            preview, parameter values, model selector, dxf exporter, etc.)
            reinitialises naturally instead of needing a manual reset
            effect that would race with `ChatSession`'s auto-switch. */}
        <ConversationEditor key={conversation.id} />
      </SelectedItemsContext.Provider>
    </ConversationContext.Provider>
  );
}

type ActivePreview = {
  type: 'artifact';
  messageId: string;
  artifact: ParametricArtifact;
  assemblyComponents?: AssemblyComponent[];
} | null;

/**
 * Owns the DB/tree layer for the editor: builds the tree from
 * `useMessagesQuery`, derives the visible branch from the conversation's
 * `current_message_leaf_id`, holds preview/parameter UI state, and
 * implements the action handlers that translate user intent into the right
 * DB writes (`persistUserMessage`, `updateConversationAsync`, etc.).
 *
 * The handlers return whatever data `<ChatSession>` needs to keep its
 * `useChat` state in sync after the write lands. That keeps the
 * DB-vs-SDK ordering explicit: parent persists, then child streams.
 */
function ConversationEditor() {
  const { conversation, updateConversation, updateConversationAsync } =
    useConversation();
  const { user, billing } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const totalTokens = billing?.tokens.total ?? 0;

  // ── Per-conversation UI state ───────────────────────────────────────────
  const [model, setModel] = useState<Model>(
    conversation.settings?.model
      ? normalizeModelId(conversation.settings.model)
      : 'openai/gpt-5.6-sol',
  );
  const [activePreview, setActivePreview] = useState<ActivePreview>(null);
  const [parameters, setParameters] = useState<Parameter[]>([]);
  const [currentOutput, setCurrentOutput] = useState<Blob | undefined>();
  const [stepExporter, setStepExporter] = useState<StepExporter | null>(null);
  const [stlExporter, setStlExporter] = useState<StepExporter | null>(null);
  const [mobilePreviewVersion, setMobilePreviewVersion] = useState(0);
  // Streaming flag surfaced from <ChatSession>. While true, the preview
  // pane swaps to the bouncing loader.
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  /** Interactive SimpleCADAPI mesh (from render_mesh), shown only when idle. */
  const [simpleCadGeometry, setSimpleCadGeometry] =
    useState<BufferGeometry | null>(null);
  const [simpleCadAssemblyGroup, setSimpleCadAssemblyGroup] =
    useState<Group | null>(null);
  const simpleCadAssemblyPreviewRef =
    useRef<SimpleCadAssemblyIncrementalPreview | null>(null);
  const [simpleCadMeshLoading, setSimpleCadMeshLoading] = useState(false);
  /** Keeps an old Assembly group mounted and visible while a replacement is built. */
  const [simpleCadArtifactPreviewPending, setSimpleCadArtifactPreviewPending] =
    useState(false);
  /** Bumps when Worker session has a fresh `result` ready for tessellation. */
  const [simpleCadMeshEpoch, setSimpleCadMeshEpoch] = useState(0);
  const baseCodeRef = useRef<string | null>(null);
  const activePreviewRef = useRef<ActivePreview>(null);
  const pendingAssemblyArtifactVersionRef = useRef<string | null>(null);
  const successfulAssemblyArtifactVersionRef = useRef<string | null>(null);
  const assemblyPreviewTimingRef = useRef<{
    successful_artifact_version: string;
    dirty_part_ids: string[] | null;
    parameter_debounce_ms: number | null;
    run_code_ms: number | null;
    total_started_at_ms: number;
  } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    activePreviewRef.current = activePreview;
  }, [activePreview]);

  const disposeSimpleCadGeometry = useCallback(() => {
    setSimpleCadGeometry((prev) => {
      prev?.dispose();
      return null;
    });
  }, []);
  const disposeSimpleCadAssemblyPreview = useCallback(() => {
    simpleCadAssemblyPreviewRef.current?.dispose();
    simpleCadAssemblyPreviewRef.current = null;
    setSimpleCadAssemblyGroup(null);
  }, []);

  // MVP 3.1/3.2: register exporters as soon as `result` exists. STL may be
  // prefetched; STEP (and STL fallback) export on click from the same session.
  const handleCadExportReady = useCallback(
    ({
      sessionId,
      artifactKind = 'model',
      stl,
    }: {
      sessionId: string;
      artifactKind?: 'model' | 'assembly';
      stl?: Blob | null;
    }) => {
      if (stl) setCurrentOutput(stl);
      // Exporters are functions; use the lazy-set form so React does not invoke
      // them as state updaters.
      setStepExporter(() => {
        const exportStep: StepExporter = () =>
          exportResultBlob(sessionId, 'step');
        return exportStep;
      });
      if (artifactKind === 'assembly') {
        setStlExporter(() => null);
      } else
        setStlExporter(() => {
          const cached = stl ?? null;
          const exportStl: StepExporter = async () => {
            if (cached) return cached;
            return exportResultBlob(sessionId, 'stl');
          };
          return exportStl;
        });
      // Only the first "session has result" signal — not the later STL prefetch.
      if (stl == null) {
        setSimpleCadMeshEpoch((epoch) => epoch + 1);
      }
    },
    [],
  );

  const clearCadDownloads = useCallback(() => {
    setCurrentOutput(undefined);
    setStepExporter(() => null);
    setStlExporter(() => null);
    setSimpleCadMeshEpoch(0);
    setSimpleCadMeshLoading(false);
    disposeSimpleCadGeometry();
  }, [disposeSimpleCadGeometry]);

  // After Agent loop goes idle, tessellate `result` for the interactive preview.
  // Debounce so brief `ready` gaps during client-side tool execution do not
  // enqueue render_mesh between run_code and render_views.
  useEffect(() => {
    if (conversation.type !== 'parametric') return;
    if (isChatStreaming) {
      disposeSimpleCadGeometry();
      setSimpleCadMeshLoading(false);
      return;
    }
    if (simpleCadMeshEpoch === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setSimpleCadMeshLoading(true);

      const isAssembly =
        activePreviewRef.current?.type === 'artifact' &&
        activePreviewRef.current.artifact.artifact_kind === 'assembly';
      const successfulAssemblyArtifactVersion =
        successfulAssemblyArtifactVersionRef.current;
      if (
        isAssembly &&
        (!successfulAssemblyArtifactVersion ||
          successfulAssemblyArtifactVersion !==
            pendingAssemblyArtifactVersionRef.current)
      ) {
        setSimpleCadMeshLoading(false);
        return;
      }
      const previewTimingCandidate = assemblyPreviewTimingRef.current;
      const previewTiming =
        previewTimingCandidate?.successful_artifact_version ===
        successfulAssemblyArtifactVersion
          ? previewTimingCandidate
          : null;
      let inspectionMs: number | null = null;

      const rebuildAssemblyWorkerSession = async (): Promise<void> => {
        const currentPreview = activePreviewRef.current;
        if (
          currentPreview?.type !== 'artifact' ||
          currentPreview.artifact.artifact_kind !== 'assembly'
        ) {
          throw new Error(
            'Cannot rebuild the lost Worker session without the current Assembly source.',
          );
        }
        const rerun = await runSimpleCadCode(
          currentPreview.artifact.code,
          conversation.id,
        );
        if (
          !rerun.ok ||
          rerun.result_type !== 'Assembly' ||
          !hasResultShape(rerun.shapes ?? [])
        ) {
          throw new Error(
            rerun.error?.what_happened ??
              rerun.error?.technical_details ??
              'Could not rebuild the lost Assembly Worker session.',
          );
        }
      };
      const renderFullAssemblyMesh = async (
        fallbackReason: string,
        uniquePartCount: number,
        changes: ReturnType<typeof classifyAssemblyRenderChanges> | null,
        cause?: unknown,
        diagnostics?: {
          stage: string;
          detail: string | null;
        },
      ) => {
        let resolvedReason = fallbackReason;
        let sessionRebuilt = false;
        if (isSimpleCadWorkerSessionLossError(cause)) {
          await rebuildAssemblyWorkerSession();
          resolvedReason = 'worker_session_lost';
          sessionRebuilt = true;
        }
        let mesh;
        try {
          mesh = await renderSimpleCadMesh(conversation.id);
        } catch (error) {
          if (!isSimpleCadWorkerSessionLossError(error)) throw error;
          if (sessionRebuilt) throw error;
          await rebuildAssemblyWorkerSession();
          resolvedReason = 'worker_session_lost';
          sessionRebuilt = true;
          mesh = await renderSimpleCadMesh(conversation.id);
        }
        return {
          mode: 'full_mesh' as const,
          mesh,
          uniquePartCount,
          changes,
          fallbackReason: resolvedReason,
          fallbackStage: diagnostics?.stage ?? null,
          fallbackDetail: diagnostics?.detail ?? null,
          inspectionMs,
        };
      };
      const commitFullAssemblyMesh = (
        result: Awaited<ReturnType<typeof renderFullAssemblyMesh>>,
      ): void => {
        if (!isRenderableSimpleCadMesh(result.mesh)) {
          throw new Error(
            result.mesh.error?.what_happened ??
              result.mesh.error?.technical_details ??
              'Full Assembly mesh fallback returned no geometry.',
          );
        }
        const mainThreadStartedAt = performance.now();
        const geometry = buildSimpleCadBufferGeometry(result.mesh);
        const mainThreadRenderMs = performance.now() - mainThreadStartedAt;
        disposeSimpleCadAssemblyPreview();
        setSimpleCadGeometry((previous) => {
          previous?.dispose();
          return geometry;
        });
        setSimpleCadArtifactPreviewPending(false);
        console.info(
          '[assembly-incremental-meshing]',
          buildAssemblyIncrementalMeshingStats({
            unique_part_count: result.uniquePartCount,
            changes: result.changes,
            remeshed_part_count: result.uniquePartCount,
            worker_ms: result.mesh.timing?.worker_ms,
            transfer_ms: result.mesh.timing?.transfer_ms,
            main_thread_render_ms: mainThreadRenderMs,
            fallback_reason: result.fallbackReason,
            fallback_stage: result.fallbackStage,
            fallback_detail: result.fallbackDetail,
            parameter_debounce_ms: previewTiming?.parameter_debounce_ms,
            run_code_ms: previewTiming?.run_code_ms,
            inspection_ms: result.inspectionMs,
            total_preview_ms: previewTiming
              ? performance.now() - previewTiming.total_started_at_ms
              : null,
          }),
        );
      };
      const render = isAssembly
        ? (async () => {
            let uniquePartCount = 0;
            let pipelineStage = 'inspect_assembly_render_state';
            let inspectionDiagnostics: {
              ok: boolean;
              part_count: number;
              component_count: number;
              error: unknown;
            } | null = null;
            let changes: ReturnType<
              typeof classifyAssemblyRenderChanges
            > | null = null;
            const inspectionStartedAt = performance.now();
            try {
              const inspection = await inspectSimpleCadAssemblyRenderState(
                conversation.id,
              );
              inspectionMs = performance.now() - inspectionStartedAt;
              inspectionDiagnostics = {
                ok: inspection.ok,
                part_count: inspection.parts.length,
                component_count: inspection.components.length,
                error: inspection.error,
              };
              console.info(
                '[assembly-incremental-meshing:inspection]',
                inspectionDiagnostics,
              );
              uniquePartCount = inspection.parts.length;
              pipelineStage = 'build_assembly_render_snapshot';
              const snapshot = buildAssemblyRenderSnapshot({
                successful_artifact_version: successfulAssemblyArtifactVersion!,
                inspection,
              });
              let preview =
                simpleCadAssemblyPreviewRef.current ??
                new SimpleCadAssemblyIncrementalPreview();
              if (
                preview.getSnapshot() &&
                preview.getSnapshot()?.meshing_settings_version !==
                  snapshot.meshing_settings_version
              ) {
                preview.dispose();
                preview = new SimpleCadAssemblyIncrementalPreview();
              }
              const expectedPreviousArtifactVersion =
                preview.getSnapshot()?.successful_artifact_version ?? null;
              pipelineStage = 'classify_assembly_render_changes';
              changes = classifyAssemblyRenderChanges({
                previous: preview.getSnapshot(),
                current: snapshot,
                dirty_part_ids: previewTiming?.dirty_part_ids ?? null,
              });
              const partIdsToMesh = changes.part_ids_to_mesh;
              const renderedParts =
                partIdsToMesh.length > 0
                  ? await (async () => {
                      pipelineStage = 'render_assembly_part_meshes';
                      return renderSimpleCadAssemblyPartMeshes(
                        conversation.id,
                        partIdsToMesh,
                      );
                    })()
                  : { ok: true as const, error: null, parts: [] };
              return {
                mode: 'incremental' as const,
                preview,
                snapshot,
                changes,
                renderedParts,
                requestedPartIds: partIdsToMesh,
                remeshedPartCount: partIdsToMesh.length,
                expectedPreviousArtifactVersion,
                inspectionMs,
              };
            } catch (error) {
              inspectionMs ??= performance.now() - inspectionStartedAt;
              const detail = inspectionDiagnostics?.error
                ? JSON.stringify(inspectionDiagnostics.error)
                : error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error);
              console.error('[assembly-incremental-meshing:error]', {
                stage: pipelineStage,
                inspection: inspectionDiagnostics,
                detail,
                cause: error,
              });
              return renderFullAssemblyMesh(
                'incremental_pipeline_error',
                uniquePartCount,
                changes,
                error,
                {
                  stage: pipelineStage,
                  detail,
                },
              );
            }
          })()
        : renderSimpleCadMesh(conversation.id);
      void render
        .then(async (meshResult) => {
          if (cancelled) return;
          if (isAssembly) {
            const assemblyResult = meshResult as
              | Awaited<ReturnType<typeof renderFullAssemblyMesh>>
              | {
                  mode: 'incremental';
                  preview: SimpleCadAssemblyIncrementalPreview;
                  snapshot: ReturnType<typeof buildAssemblyRenderSnapshot>;
                  changes: ReturnType<typeof classifyAssemblyRenderChanges>;
                  renderedParts: Awaited<
                    ReturnType<typeof renderSimpleCadAssemblyPartMeshes>
                  >;
                  requestedPartIds: string[];
                  remeshedPartCount: number;
                  expectedPreviousArtifactVersion: string | null;
                  inspectionMs: number | null;
                };
            if (
              successfulAssemblyArtifactVersionRef.current !==
              successfulAssemblyArtifactVersion
            )
              return;
            if (assemblyResult.mode === 'full_mesh') {
              commitFullAssemblyMesh(assemblyResult);
              return;
            }
            const visibility =
              activePreviewRef.current?.type === 'artifact'
                ? (activePreviewRef.current.artifact.assembly_visibility ?? {})
                : {};
            const preview = assemblyResult.preview;
            const mainThreadStartedAt = performance.now();
            let group: Group;
            try {
              group = preview.apply({
                snapshot: assemblyResult.snapshot,
                rendered_parts: assemblyResult.renderedParts,
                visibility,
                expected_previous_artifact_version:
                  assemblyResult.expectedPreviousArtifactVersion,
                expected_rendered_part_ids: assemblyResult.requestedPartIds,
              });
            } catch (cacheError) {
              if (
                cacheError instanceof Error &&
                cacheError.message.includes('Stale Assembly mesh update')
              )
                throw cacheError;
              const cacheDetail =
                cacheError instanceof Error
                  ? `${cacheError.name}: ${cacheError.message}`
                  : String(cacheError);
              console.warn('[assembly-incremental-meshing:mesh-cache]', {
                detail: cacheDetail,
                cause: cacheError,
              });
              preview.dispose();
              const fallback = await renderFullAssemblyMesh(
                'mesh_cache_unavailable',
                assemblyResult.snapshot.parts.length,
                assemblyResult.changes,
                cacheError,
                {
                  stage: 'apply_assembly_cache',
                  detail: cacheDetail,
                },
              );
              if (
                cancelled ||
                successfulAssemblyArtifactVersionRef.current !==
                  assemblyResult.snapshot.successful_artifact_version
              )
                return;
              commitFullAssemblyMesh(fallback);
              return;
            }
            const mainThreadRenderMs = performance.now() - mainThreadStartedAt;
            simpleCadAssemblyPreviewRef.current = preview;
            disposeSimpleCadGeometry();
            setSimpleCadAssemblyGroup(group);
            setSimpleCadArtifactPreviewPending(false);
            console.info(
              '[assembly-incremental-meshing]',
              buildAssemblyIncrementalMeshingStats({
                unique_part_count: assemblyResult.snapshot.parts.length,
                changes: assemblyResult.changes,
                remeshed_part_count: assemblyResult.remeshedPartCount,
                worker_ms: assemblyResult.renderedParts.timing?.worker_ms,
                transfer_ms: assemblyResult.renderedParts.timing?.transfer_ms,
                main_thread_render_ms: mainThreadRenderMs,
                parameter_debounce_ms: previewTiming?.parameter_debounce_ms,
                run_code_ms: previewTiming?.run_code_ms,
                inspection_ms: assemblyResult.inspectionMs,
                total_preview_ms: previewTiming
                  ? performance.now() - previewTiming.total_started_at_ms
                  : null,
              }),
            );
            return;
          }
          const mesh = meshResult as Awaited<
            ReturnType<typeof renderSimpleCadMesh>
          >;
          if (!isRenderableSimpleCadMesh(mesh)) {
            const detail =
              mesh.error?.what_happened ??
              mesh.error?.technical_details ??
              'render_mesh returned no geometry';
            console.warn('SimpleCADAPI interactive preview failed:', detail);
            toast({
              title: '3D preview unavailable',
              description: detail,
              variant: 'destructive',
            });
            disposeSimpleCadGeometry();
            return;
          }
          const geometry = buildSimpleCadBufferGeometry(mesh);
          disposeSimpleCadAssemblyPreview();
          setSimpleCadGeometry((prev) => {
            prev?.dispose();
            return geometry;
          });
          setSimpleCadArtifactPreviewPending(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.warn('SimpleCADAPI interactive preview failed:', error);
          toast({
            title: '3D preview unavailable',
            description:
              error instanceof Error
                ? error.message
                : 'Could not tessellate the model for preview.',
            variant: 'destructive',
          });
          disposeSimpleCadGeometry();
          disposeSimpleCadAssemblyPreview();
          setSimpleCadArtifactPreviewPending(false);
        })
        .finally(() => {
          if (!cancelled) setSimpleCadMeshLoading(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    conversation.id,
    conversation.type,
    disposeSimpleCadAssemblyPreview,
    disposeSimpleCadGeometry,
    isChatStreaming,
    simpleCadMeshEpoch,
    toast,
  ]);

  // Dispose GPU buffers if this editor instance unmounts (conversation switch).
  useEffect(() => {
    return () => {
      setSimpleCadGeometry((prev) => {
        prev?.dispose();
        return null;
      });
      setSimpleCadAssemblyGroup((_prev) => {
        simpleCadAssemblyPreviewRef.current?.dispose();
        simpleCadAssemblyPreviewRef.current = null;
        return null;
      });
    };
  }, []);

  // ── Source of truth: DB messages → tree → branch ───────────────────────
  const { data: dbMessages = [], isFetched: areMessagesFetched } =
    useMessagesQuery();
  const chatMessages = useMemo(
    () => dbMessages.map(messageRowToChatMessage),
    [dbMessages],
  );
  const dbTree = useMemo(() => new Tree(chatMessages), [chatMessages]);
  const branchForLeaf = useCallback(
    (leafId: string): AppUIMessage[] =>
      dbTree.getPath(leafId).map((node) => ({
        id: node.id,
        role: node.role,
        parts: node.parts,
        metadata: node.metadata,
      })),
    [dbTree],
  );
  const leafId =
    conversation.current_message_leaf_id ?? dbMessages.at(-1)?.id ?? '';
  const initialBranch = useMemo(
    () => branchForLeaf(leafId),
    [branchForLeaf, leafId],
  );

  const updateSelectedModel = useCallback(
    (nextModel: Model) => {
      setModel(nextModel);
      updateConversation?.({
        ...conversation,
        settings: {
          ...(typeof conversation.settings === 'object'
            ? conversation.settings
            : {}),
          model: nextModel,
        },
      });
    },
    [conversation, updateConversation],
  );

  // ── Action handlers — single responsibility: write the DB rows that
  // describe the next tree state, then return whatever ChatSession needs
  // to keep `chat.messages` aligned. ──────────────────────────────────
  const handleSendParts = useCallback(
    async (parts: AppUIMessage['parts']) => {
      if (!user?.id) throw new Error('User must be authenticated');
      await ensureInputRecords({
        parts,
        conversationId: conversation.id,
        userId: user.id,
      });
      const parentMessageId = conversation.current_message_leaf_id ?? null;
      const userMessageId = await persistUserMessage({
        conversationId: conversation.id,
        parts,
        metadata: { model },
        parentMessageId,
      });
      // The `update_leaf_trigger` advances the DB leaf to `userMessageId`;
      // mirror that in the cache so the next render shows the user bubble
      // immediately even before the messages query refetches.
      queryClient.setQueryData(
        ['conversation', conversation.id],
        (old: Conversation | undefined) =>
          old ? { ...old, current_message_leaf_id: userMessageId } : old,
      );
      return { userMessageId };
    },
    [conversation, model, queryClient, user?.id],
  );

  const handleRetry = useCallback(
    async (assistant: ChatMessage) => {
      const parentId = assistant.parent_message_id;
      if (!parentId) return;
      await updateConversationAsync?.({
        ...conversation,
        current_message_leaf_id: parentId,
      });
    },
    [conversation, updateConversationAsync],
  );

  const handleEdit = useCallback(
    async (original: ChatMessage, parts: AppUIMessage['parts']) => {
      if (!user?.id) throw new Error('User must be authenticated');
      await ensureInputRecords({
        parts,
        conversationId: conversation.id,
        userId: user.id,
      });
      const parentId = original.parent_message_id;
      const newUserMessageId = await persistUserMessage({
        conversationId: conversation.id,
        parts,
        metadata: { model },
        parentMessageId: parentId,
      });
      queryClient.setQueryData(
        ['conversation', conversation.id],
        (old: Conversation | undefined) =>
          old ? { ...old, current_message_leaf_id: newUserMessageId } : old,
      );
      const parentPath = parentId ? branchForLeaf(parentId) : [];
      return { newUserMessageId, parentPath };
    },
    [branchForLeaf, conversation, model, queryClient, user?.id],
  );

  const handleRestore = useCallback(
    async (assistant: ChatMessage) => {
      const newId = crypto.randomUUID();
      const parts = JSON.parse(JSON.stringify(assistant.parts));
      const metadata = JSON.parse(JSON.stringify(assistant.metadata ?? {}));
      // Restore only fires for assistants in the UI, so the role is
      // narrowed here for the strict `messages` row type ('user' |
      // 'assistant'); the broader `'system'` slot on UIMessage is
      // never legitimate to copy.
      const role: Message['role'] = 'assistant';
      const { error } = await supabase.from('messages').insert({
        id: newId,
        conversation_id: conversation.id,
        role,
        parts,
        metadata,
        parent_message_id: assistant.parent_message_id,
        rating: 0,
      });
      if (error) throw error;

      // Mirror the trigger's leaf advance + add the copy to the messages
      // cache optimistically so the new branch resolves before refetch.
      queryClient.setQueryData(
        ['conversation', conversation.id],
        (old: Conversation | undefined) =>
          old ? { ...old, current_message_leaf_id: newId } : old,
      );
      queryClient.setQueryData(
        ['messages', conversation.id],
        (old: Message[] | undefined): Message[] => [
          ...(old ?? []),
          {
            id: newId,
            conversation_id: conversation.id,
            role,
            parts,
            metadata,
            parent_message_id: assistant.parent_message_id,
            rating: 0,
            created_at: new Date().toISOString(),
          },
        ],
      );
      queryClient.invalidateQueries({
        queryKey: ['messages', conversation.id],
      });

      const parentPath = assistant.parent_message_id
        ? branchForLeaf(assistant.parent_message_id)
        : [];
      const newBranch: AppUIMessage[] = [
        ...parentPath,
        { id: newId, role, parts, metadata },
      ];
      return { newBranch };
    },
    [branchForLeaf, conversation.id, queryClient],
  );

  const handleSelectLeaf = useCallback(
    async (messageId: string) => {
      await updateConversationAsync?.({
        ...conversation,
        current_message_leaf_id: messageId,
      });
    },
    [conversation, updateConversationAsync],
  );

  const handleToolOutput = useCallback(
    async (
      messageId: string,
      nextParts: AppUIMessage['parts'],
      metadata?: AppUIMessage['metadata'],
    ) => {
      await persistAssistantParts({
        conversationId: conversation.id,
        messageId,
        parts: nextParts,
        metadata,
      });
      queryClient.setQueryData(
        ['messages', conversation.id],
        (old: Message[] | undefined): Message[] =>
          (old ?? []).map((row) =>
            row.id === messageId
              ? { ...row, parts: nextParts, ...(metadata ? { metadata } : {}) }
              : row,
          ),
      );
    },
    [conversation.id, queryClient],
  );

  const { mutate: changeRatingMutation } = useChangeRatingMutation({
    conversationId: conversation.id,
  });
  const handleChangeRating = useCallback(
    (messageId: string, rating: number) => {
      changeRatingMutation({ messageId, rating });
    },
    [changeRatingMutation],
  );

  // Serialize parameter-driven / restore SimpleCADAPI rebuilds so a stale
  // run_code result cannot overwrite a newer slider commit or view switch.
  const parametricRerunGenRef = useRef(0);

  const rerunParametricWithCode = useCallback(
    async (
      code: string,
      successfulArtifactVersion: string,
      parameterTiming?: ParameterChangeTiming,
      previousSuccessfulAssembly?: {
        artifactVersion: string;
        changedParameterNames: string[];
      },
    ) => {
      pendingAssemblyArtifactVersionRef.current = successfulArtifactVersion;
      const gen = ++parametricRerunGenRef.current;
      const sessionId = conversation.id;
      setSimpleCadMeshLoading(true);
      const runCodeStartedAt = performance.now();
      const totalStartedAt = parameterTiming?.started_at_ms ?? runCodeStartedAt;
      try {
        let runResult;
        let dirtyPartIds: string[] | null = null;
        let sectionExecutionDiagnostic:
          | {
              changed_parameter_names: string[];
              planned_mode: 'partial' | 'full';
              planned_section_keys: string[];
              planned_fallback_reason: string | null;
            }
          | undefined;
        if (previousSuccessfulAssembly) {
          const analysis = await analyzeSimpleCadAssemblySections(code);
          if (gen !== parametricRerunGenRef.current) return;
          const plan = planAssemblySectionExecution({
            next_source: code,
            analysis,
            change: {
              kind: 'parameters',
              parameter_names: previousSuccessfulAssembly.changedParameterNames,
            },
            previous_successful_artifact_version:
              previousSuccessfulAssembly.artifactVersion,
            next_artifact_version: successfulArtifactVersion,
          });
          sectionExecutionDiagnostic = {
            changed_parameter_names: plan.changed_parameter_names,
            planned_mode: plan.mode,
            planned_section_keys:
              plan.mode === 'partial'
                ? plan.sections_to_execute.map(
                    (section) => `${section.kind}/${section.id}`,
                  )
                : [],
            planned_fallback_reason: plan.mode === 'full' ? plan.reason : null,
          };
          if (plan.mode === 'partial') {
            dirtyPartIds = plan.affected_part_ids;
          }
          runResult =
            plan.mode === 'partial'
              ? await runSimpleCadAssemblySections(code, sessionId, plan)
              : await runSimpleCadCode(
                  code,
                  sessionId,
                  successfulArtifactVersion,
                );
          if (
            plan.mode === 'partial' &&
            'execution_mode' in runResult &&
            runResult.execution_mode !== 'partial'
          ) {
            dirtyPartIds = null;
          }
          console.info('[assembly-section-execution]', {
            ...sectionExecutionDiagnostic,
            execution_mode:
              'execution_mode' in runResult ? runResult.execution_mode : 'full',
            section_fallback_reason:
              'fallback_reason' in runResult
                ? runResult.fallback_reason
                : sectionExecutionDiagnostic.planned_fallback_reason,
            executed_section_count:
              'executed_sections' in runResult &&
              Array.isArray(runResult.executed_sections)
                ? runResult.executed_sections.length
                : 0,
            partial_failure_detail:
              'partial_failure_detail' in runResult &&
              typeof runResult.partial_failure_detail === 'string'
                ? runResult.partial_failure_detail
                : null,
          });
        } else {
          // Initial load / restore / history / Agent-authored source all enter
          // here. Registering this complete run establishes the only baseline
          // a later Parameters-panel edit may use.
          runResult = await runSimpleCadCode(
            code,
            sessionId,
            successfulArtifactVersion,
          );
        }
        const runCodeMs = performance.now() - runCodeStartedAt;
        if (gen !== parametricRerunGenRef.current) return;
        if (!runResult.ok || !hasResultShape(runResult.shapes ?? [])) {
          const detail =
            runResult.error?.what_happened ??
            runResult.error?.technical_details ??
            (!runResult.ok
              ? 'Script failed while rebuilding the model'
              : 'result shape missing while rebuilding the model');
          toast({
            title: 'CAD rebuild failed',
            description: detail,
            variant: 'destructive',
          });
          disposeSimpleCadAssemblyPreview();
          setSimpleCadArtifactPreviewPending(false);
          setSimpleCadMeshLoading(false);
          return;
        }
        const artifactKind =
          runResult.result_type === 'Assembly' ? 'assembly' : 'model';
        if (artifactKind === 'assembly') {
          assemblyPreviewTimingRef.current = {
            successful_artifact_version: successfulArtifactVersion,
            dirty_part_ids: dirtyPartIds,
            parameter_debounce_ms: parameterTiming?.debounce_ms ?? null,
            run_code_ms: runCodeMs,
            total_started_at_ms: totalStartedAt,
          };
        }
        successfulAssemblyArtifactVersionRef.current =
          artifactKind === 'assembly' ? successfulArtifactVersion : null;
        // Commit the successful version before bumping the mesh epoch.
        handleCadExportReady({ sessionId, artifactKind });
        if (artifactKind === 'model') {
          void exportResultBlob(sessionId, 'stl')
            .then((stl) => {
              if (gen !== parametricRerunGenRef.current) return;
              handleCadExportReady({ sessionId, artifactKind, stl });
            })
            .catch((error) => {
              if (gen !== parametricRerunGenRef.current) return;
              console.warn(
                'SimpleCADAPI export refresh after rebuild failed:',
                error,
              );
            });
        }
      } catch (error) {
        if (gen !== parametricRerunGenRef.current) return;
        toast({
          title: 'CAD rebuild failed',
          description:
            error instanceof Error
              ? error.message
              : 'Could not rebuild the model for preview.',
          variant: 'destructive',
        });
        disposeSimpleCadAssemblyPreview();
        setSimpleCadArtifactPreviewPending(false);
        setSimpleCadMeshLoading(false);
      }
    },
    [
      conversation.id,
      disposeSimpleCadAssemblyPreview,
      handleCadExportReady,
      toast,
    ],
  );

  // ── Preview-pane callbacks (called by ChatSession when a new artifact /
  // mesh lands, or by the user clicking the Eye icon on a bubble). ──────
  const handleViewArtifact = useCallback(
    (
      artifact: ParametricArtifact,
      messageId: string,
      componentOverride?: AssemblyComponent[],
      workerResult?: {
        modelRevision: string;
        dirtyPartIds: string[] | null;
        removedPartIds: string[];
        affectedComponentIds: string[];
      },
    ) => {
      baseCodeRef.current = artifact.code;
      // Parameters are derived from the artifact source — same code always
      // yields the same parameter controls, no matter which model wrote
      // it. SimpleCADAPI Python uses top-level literal assignments with optional
      // `# [min:max]` ranges.
      // Current values come from the (possibly edited) artifact code; the
      // `defaultValue` (Reset target / slider home / auto range) comes from
      // `metadata.originalCode` — the model's first-authored source — so an
      // in-place parameter edit doesn't redefine the default on the next
      // reload. Read from the cache to keep this callback stable.
      const originalCode = queryClient
        .getQueryData<Message[]>(['messages', conversation.id])
        ?.find((row) => row.id === messageId)?.metadata?.originalCode;
      const assemblyComponents =
        componentOverride ??
        assemblyComponentsFromParts(
          queryClient
            .getQueryData<Message[]>(['messages', conversation.id])
            ?.find((row) => row.id === messageId)?.parts,
        );
      const previewArtifact =
        artifact.artifact_kind === 'assembly'
          ? {
              ...artifact,
              assembly_visibility: normalizeAssemblyVisibility(
                artifact.assembly_visibility,
                assemblyComponents,
              ),
            }
          : artifact;
      setParameters(mergeParameterDefaults(previewArtifact.code, originalCode));
      clearCadDownloads();
      setActivePreview({
        type: 'artifact',
        messageId,
        artifact: previewArtifact,
        assemblyComponents,
      });
      setMobilePreviewVersion((version) => version + 1);

      // Parametric SimpleCADAPI: geometry lives only in the in-memory Worker
      // session. Always rebuild from the artifact Python (`run_code` → remesh
      // + STEP/STL exporters) so page reload and Eye clicks share one path.
      if (conversation.type === 'parametric') {
        const sessionId = conversation.id;
        const code = previewArtifact.code;
        const modelRevision =
          workerResult?.modelRevision ??
          queryClient
            .getQueryData<Message[]>(['messages', conversation.id])
            ?.find((row) => row.id === messageId)?.metadata?.modelSnapshot
            ?.modelRevision ??
          messageId;
        const successfulArtifactVersion =
          buildAssemblySuccessfulArtifactVersion({
            model_revision: modelRevision,
            source_code: code,
          });
        pendingAssemblyArtifactVersionRef.current = successfulArtifactVersion;
        setSimpleCadArtifactPreviewPending(true);
        if (workerResult) {
          const artifactKind = previewArtifact.artifact_kind ?? 'model';
          successfulAssemblyArtifactVersionRef.current =
            artifactKind === 'assembly' ? successfulArtifactVersion : null;
          if (artifactKind === 'assembly') {
            assemblyPreviewTimingRef.current = {
              successful_artifact_version: successfulArtifactVersion,
              dirty_part_ids: workerResult.dirtyPartIds,
              parameter_debounce_ms: null,
              run_code_ms: null,
              total_started_at_ms: performance.now(),
            };
            void registerSimpleCadAssemblyBaseline(
              sessionId,
              successfulArtifactVersion,
            )
              .then((registration) => {
                if (!registration.ok) {
                  console.warn(
                    'Could not register the Agent Assembly baseline for parameter updates.',
                  );
                }
              })
              .catch((error) => {
                console.warn(
                  'Could not register the Agent Assembly baseline for parameter updates:',
                  error,
                );
              });
          }
          handleCadExportReady({ sessionId, artifactKind });
          if (artifactKind === 'model') {
            void exportResultBlob(sessionId, 'stl')
              .then((stl) =>
                handleCadExportReady({ sessionId, artifactKind, stl }),
              )
              .catch((error) => {
                console.warn(
                  'SimpleCADAPI export refresh after Agent revision failed:',
                  error,
                );
              });
          }
          return;
        }
        void (async () => {
          // Await enter so a late first-enter reset cannot wipe `result`
          // between run_code and mesh/export.
          await enterSimpleCadSession(sessionId);
          await rerunParametricWithCode(code, successfulArtifactVersion);
        })();
      }
    },
    [
      clearCadDownloads,
      conversation.id,
      conversation.type,
      handleCadExportReady,
      queryClient,
      rerunParametricWithCode,
    ],
  );
  // Serialize parameter writes (see `drainParameterWrites`): one queued
  // snapshot per message id, plus a flag so at most one persist is ever in
  // flight. Keying by message means switching artifacts mid-write can't drop
  // the other artifact's pending edit.
  const pendingWritesRef = useRef<
    Map<string, { artifact: ParametricArtifact; originalCode: string | null }>
  >(new Map());
  const writeInFlightRef = useRef(false);

  // Persist an in-place parameter edit back onto the assistant message's
  // `tool-build_parametric_model` part so it survives the `key={conversation.id}`
  // remount and a fresh `useMessagesQuery` fetch. Parameters are derived from
  // the artifact code, so writing the updated code is all that's needed — no
  // schema change. Mirrors `handleToolOutput`: DB write first, then cache, so a
  // post-stream `['messages']` invalidation refetches the already-edited row
  // instead of reverting. Reads `dbMessages` live (not a captured snapshot) so
  // `replaceBuildParametricModelOutput` indexes into the current parts array.
  const persistParameterEdit = useCallback(
    async (
      messageId: string,
      artifact: ParametricArtifact,
      originalCode: string | null,
    ) => {
      const row = dbMessages.find((message) => message.id === messageId);
      if (!row) return;
      const nextParts = replaceBuildParametricModelOutput(row.parts, artifact);
      // Lazily capture the model's original source the first time a parameter
      // is edited. Before this feature edits never persisted, so a message
      // lacking `originalCode` still holds the model's original in its stored
      // code — the pre-edit code, captured at enqueue time in
      // `changeParameters`. Pinning it there (rather than reading `baseCodeRef`
      // here) keeps an in-flight write from grabbing a *different* artifact's
      // code after the user switches previews mid-drain. Anchors the derived
      // `defaultValue` (Reset / slider home / range) with no migration or
      // duplicate copy on never-edited artifacts.
      const nextSnapshot = row.metadata?.modelSnapshot
        ? refreshSnapshotAssemblyVisibility(
            refreshSnapshotParameters(
              row.metadata.modelSnapshot,
              parseParameters(artifact.code),
            ),
            artifact.assembly_visibility,
          )
        : undefined;
      const nextMetadata =
        originalCode && !row.metadata?.originalCode
          ? {
              ...row.metadata,
              originalCode,
              ...(nextSnapshot ? { modelSnapshot: nextSnapshot } : {}),
            }
          : nextSnapshot
            ? { ...row.metadata, modelSnapshot: nextSnapshot }
            : undefined;
      try {
        await persistAssistantParts({
          conversationId: conversation.id,
          messageId,
          parts: nextParts,
          metadata: nextMetadata,
        });
      } catch (error) {
        // A failed write must never break the live preview — the edit stays
        // in local state and the next change retries the persist.
        console.warn('Failed to persist parameter edit:', error);
        return;
      }
      queryClient.setQueryData(
        ['messages', conversation.id],
        (old: Message[] | undefined): Message[] =>
          (old ?? []).map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  parts: nextParts,
                  ...(nextMetadata ? { metadata: nextMetadata } : {}),
                }
              : message,
          ),
      );
    },
    [conversation.id, dbMessages, queryClient],
  );

  // Flush queued parameter writes one at a time. Each `changeParameters`
  // rebuilds the full code from `baseCodeRef`, so coalescing to the latest
  // queued snapshot per message never drops an edit — but two overlapping
  // writes could commit out of order and leave stale code in the row, so we
  // never let them run concurrently.
  const drainParameterWrites = useCallback(async () => {
    if (writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    try {
      while (pendingWritesRef.current.size > 0) {
        const entry = pendingWritesRef.current.entries().next().value;
        if (!entry) break;
        const [messageId, write] = entry;
        pendingWritesRef.current.delete(messageId);
        await persistParameterEdit(
          messageId,
          write.artifact,
          write.originalCode,
        );
      }
    } finally {
      writeInFlightRef.current = false;
    }
  }, [persistParameterEdit]);

  const changeParameters = useCallback(
    (nextParameters: Parameter[], parameterTiming?: ParameterChangeTiming) => {
      if (!baseCodeRef.current || activePreview?.type !== 'artifact') return;
      let nextCode = baseCodeRef.current;
      for (const parameter of nextParameters) {
        nextCode = updateParameter(nextCode, parameter);
      }
      const currentParameterValues = new Map(
        parseParameters(activePreview.artifact.code).map((parameter) => [
          parameter.name,
          JSON.stringify(parameter.value),
        ]),
      );
      const changedParameterNames = nextParameters
        .filter(
          (parameter) =>
            currentParameterValues.get(parameter.name) !==
            JSON.stringify(parameter.value),
        )
        .map((parameter) => parameter.name);
      setParameters(nextParameters);
      const updatedArtifact: ParametricArtifact = {
        ...activePreview.artifact,
        code: nextCode,
      };
      setActivePreview({
        ...activePreview,
        artifact: updatedArtifact,
      });
      // Skip the DB write while a stream is landing on this branch —
      // `handleToolOutput` owns the row's parts during a stream and would
      // clobber (or be clobbered by) a concurrent parameter write. The live
      // preview above still updates regardless.
      if (!isChatStreaming) {
        // Pin the original code at enqueue time — `baseCodeRef` is mutated by
        // `handleViewArtifact` on preview switch, and an in-flight drain must
        // not read a later artifact's code for this message's `originalCode`.
        pendingWritesRef.current.set(activePreview.messageId, {
          artifact: updatedArtifact,
          originalCode: baseCodeRef.current,
        });
        void drainParameterWrites();
      }

      // SimpleCADAPI: edited Python does not auto-refresh the Worker session.
      // Re-run the full script, then remesh / refresh downloads.
      if (conversation.type === 'parametric' && !isChatStreaming) {
        const modelRevision =
          queryClient
            .getQueryData<Message[]>(['messages', conversation.id])
            ?.find((row) => row.id === activePreview.messageId)?.metadata
            ?.modelSnapshot?.modelRevision ?? activePreview.messageId;
        const successfulArtifactVersion =
          buildAssemblySuccessfulArtifactVersion({
            model_revision: modelRevision,
            source_code: nextCode,
          });
        void rerunParametricWithCode(
          nextCode,
          successfulArtifactVersion,
          parameterTiming,
          successfulAssemblyArtifactVersionRef.current
            ? {
                artifactVersion: successfulAssemblyArtifactVersionRef.current,
                changedParameterNames,
              }
            : undefined,
        );
      }
    },
    [
      activePreview,
      conversation.type,
      conversation.id,
      drainParameterWrites,
      isChatStreaming,
      rerunParametricWithCode,
      queryClient,
    ],
  );

  const changeAssemblyVisibility = useCallback(
    (visibility: Record<string, boolean>) => {
      if (
        activePreview?.type !== 'artifact' ||
        activePreview.artifact.artifact_kind !== 'assembly'
      )
        return;
      const artifact = {
        ...activePreview.artifact,
        assembly_visibility: visibility,
      };
      setActivePreview({ ...activePreview, artifact });
      simpleCadAssemblyPreviewRef.current?.setVisibility(visibility);
      if (!isChatStreaming) {
        void persistParameterEdit(activePreview.messageId, artifact, null);
      }
    },
    [activePreview, isChatStreaming, persistParameterEdit],
  );

  const updatePrivacy = useCallback(
    (privacy: 'public' | 'private') => {
      updateConversation?.({ ...conversation, privacy });
    },
    [conversation, updateConversation],
  );

  // Latest preview in the *persisted* branch — used as the share-popover
  // fallback before the user has clicked any artifact and before any
  // streaming completes (ChatSession's onToolCall auto-switches once a
  // fresher preview arrives, which updates activePreview directly).
  // Show the right-hand panel whenever there is an artifact. SimpleCADAPI
  // scripts may have no editable literals, but still expose downloads.
  const hasArtifact =
    activePreview?.type === 'artifact' &&
    (parameters.length > 0 ||
      conversation.type === 'parametric' ||
      !!stepExporter ||
      !!stlExporter);

  // `useCachedAiChat` captures `initialBranch` once at Chat construction;
  // if the messages query hasn't completed its first fetch yet the
  // branch is `[]` and the Chat gets locked in empty for this
  // conversation. Hold the render at a spinner until the messages query
  // settles so the Chat is constructed with the real branch on its
  // first frame.
  if (!areMessagesFetched) {
    return (
      <div className="iris-editor-route-loading flex h-full w-full items-center justify-center text-adam-text-primary">
        <Loader2 className="h-10 w-10 animate-spin" />
      </div>
    );
  }

  return (
    <ConversationView
      hasParameters={hasArtifact}
      previewActionSlot={
        <PreviewExportControl
          filenameBase={modelFilename(
            activePreview?.type === 'artifact'
              ? activePreview.artifact.title
              : undefined,
            conversation.title,
          )}
          currentOutput={currentOutput}
          stepExporter={stepExporter}
          stlExporter={stlExporter}
          code={
            activePreview?.type === 'artifact'
              ? activePreview.artifact.code
              : undefined
          }
        />
      }
      mobilePreviewKey={
        activePreview ? `artifact:${activePreview.messageId}` : null
      }
      mobilePreviewVersion={mobilePreviewVersion}
      chatPanelSlot={
        <>
          {/* `pl-12` reserves space for the rotated "Chat" expand button
              that sits in the left gutter when the chat panel is collapsed,
              so the title and share button don't get covered. */}
          <div className="flex w-full items-center justify-between bg-transparent p-3 md:pl-12">
            <div className="flex min-w-0 flex-1 items-center space-x-2">
              <div className="min-w-0 flex-1">
                <ChatTitle />
              </div>
            </div>
            <div className="hidden items-center gap-3 md:flex">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className="flex h-8 items-center gap-2 rounded-full px-3 text-adam-text-primary hover:bg-adam-neutral-950 hover:text-adam-neutral-10 focus-visible:ring-0"
                  >
                    <Share className="h-[14px] w-[14px] min-w-[14px]" />
                    <span>Share</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="iris-share-popover w-72 p-3"
                >
                  <ShareContent
                    conversationId={conversation.id}
                    privacy={conversation.privacy}
                    onPrivacyChange={updatePrivacy}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex items-center gap-3 md:hidden">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 bg-transparent p-0 hover:bg-transparent"
                onClick={() => {
                  navigate({ to: '/' });
                }}
                aria-label="New Creation"
              >
                <CreateIcon className="h-5 w-5 text-adam-text-primary" />
              </Button>
            </div>
          </div>

          <ChatSession
            conversation={conversation}
            dbMessages={dbMessages as Message[]}
            initialBranch={initialBranch}
            model={model}
            setModel={updateSelectedModel}
            isDisabled={totalTokens <= 0}
            onSendParts={handleSendParts}
            onRetry={handleRetry}
            onEdit={handleEdit}
            onRestore={handleRestore}
            onSelectLeaf={handleSelectLeaf}
            branchForLeaf={branchForLeaf}
            onToolOutput={handleToolOutput}
            onChangeRating={handleChangeRating}
            onViewArtifact={handleViewArtifact}
            onLoadingChange={setIsChatStreaming}
          />
        </>
      }
      previewSlot={
        <div className="iris-preview-surface flex h-full w-full items-center justify-center">
          {simpleCadGeometry || simpleCadAssemblyGroup ? (
            <div className="relative h-full w-full">
              <ThreeScene
                boundsRevision={
                  simpleCadMeshEpoch * 2 +
                  Number(simpleCadArtifactPreviewPending)
                }
                previewKey={
                  activePreview?.type === 'artifact'
                    ? `${activePreview.messageId}:${activePreview.artifact.version}`
                    : undefined
                }
                filenameBase={modelFilename(
                  activePreview?.type === 'artifact'
                    ? activePreview.artifact.title
                    : undefined,
                  conversation.title,
                )}
                geometry={simpleCadGeometry}
                coloredGroup={simpleCadAssemblyGroup}
                color="#5c6470"
              />
              {isChatStreaming || simpleCadArtifactPreviewPending ? (
                <div className="iris-preview-loading-overlay absolute inset-0 flex items-center justify-center">
                  <Loader showLoadingText />
                </div>
              ) : null}
            </div>
          ) : isChatStreaming ? (
            <Loader showLoadingText />
          ) : activePreview?.type === 'artifact' ? (
            simpleCadMeshLoading ||
            simpleCadMeshEpoch > 0 ||
            stepExporter ||
            stlExporter ? (
              <Loader showLoadingText />
            ) : (
              <div className="max-w-sm px-6 text-center text-sm text-adam-text-secondary">
                Waiting for geometry…
              </div>
            )
          ) : (
            <div className="text-sm text-adam-text-secondary">
              Send a message to start creating
            </div>
          )}
        </div>
      }
      mobilePreviewSlot={
        <div className="flex h-full w-full items-center justify-center bg-adam-bg-secondary-dark">
          {simpleCadGeometry || simpleCadAssemblyGroup ? (
            <div className="relative h-full w-full">
              <ThreeScene
                boundsRevision={
                  simpleCadMeshEpoch * 2 +
                  Number(simpleCadArtifactPreviewPending)
                }
                previewKey={
                  activePreview?.type === 'artifact'
                    ? `${activePreview.messageId}:${activePreview.artifact.version}`
                    : undefined
                }
                filenameBase={modelFilename(
                  activePreview?.type === 'artifact'
                    ? activePreview.artifact.title
                    : undefined,
                  conversation.title,
                )}
                geometry={simpleCadGeometry}
                coloredGroup={simpleCadAssemblyGroup}
                color="#5c6470"
                isMobile={true}
              />
              {isChatStreaming || simpleCadArtifactPreviewPending ? (
                <div className="bg-white/72 absolute inset-0 flex items-center justify-center backdrop-blur-[1px]">
                  <Loader showLoadingText />
                </div>
              ) : null}
            </div>
          ) : isChatStreaming ? (
            <Loader showLoadingText />
          ) : activePreview?.type === 'artifact' ? (
            simpleCadMeshLoading ||
            simpleCadMeshEpoch > 0 ||
            stepExporter ||
            stlExporter ? (
              <Loader showLoadingText />
            ) : (
              <div className="max-w-sm px-6 text-center text-sm text-adam-text-secondary">
                Waiting for geometry…
              </div>
            )
          ) : (
            <div className="text-sm text-adam-text-secondary">
              Send a message to start creating
            </div>
          )}
        </div>
      }
      parametersSlot={
        <div className="relative h-full">
          <IrisModelPanel
            parameters={parameters}
            onParameterChange={changeParameters}
            parametersReadOnly={
              activePreview?.type === 'artifact' &&
              activePreview.messageId !== leafId
            }
            assemblyComponents={
              activePreview?.type === 'artifact'
                ? activePreview.assemblyComponents
                : undefined
            }
            assemblyVisibility={
              activePreview?.type === 'artifact'
                ? activePreview.artifact.assembly_visibility
                : undefined
            }
            onAssemblyVisibilityChange={
              activePreview?.type === 'artifact' &&
              activePreview.artifact.artifact_kind === 'assembly'
                ? changeAssemblyVisibility
                : undefined
            }
          />
        </div>
      }
      mobileParametersSlot={
        <ParameterSheetContent
          filenameBase={modelFilename(
            activePreview?.type === 'artifact'
              ? activePreview.artifact.title
              : undefined,
            conversation.title,
          )}
          parameters={parameters}
          onParameterChange={changeParameters}
          parametersReadOnly={
            activePreview?.type === 'artifact' &&
            activePreview.messageId !== leafId
          }
          currentOutput={currentOutput}
          stepExporter={stepExporter}
          stlExporter={stlExporter}
          code={
            activePreview?.type === 'artifact'
              ? activePreview.artifact.code
              : undefined
          }
          assemblyComponents={
            activePreview?.type === 'artifact'
              ? activePreview.assemblyComponents
              : undefined
          }
          assemblyVisibility={
            activePreview?.type === 'artifact'
              ? activePreview.artifact.assembly_visibility
              : undefined
          }
          onAssemblyVisibilityChange={
            activePreview?.type === 'artifact' &&
            activePreview.artifact.artifact_kind === 'assembly'
              ? changeAssemblyVisibility
              : undefined
          }
        />
      }
    />
  );
}

/**
 * Derive the parameter list from the live artifact code, but anchor each
 * parameter's `defaultValue` to the model's original source when we have it.
 *
 * Without this, a parameter edit (which rewrites the assignment in the live
 * code) would also become the parsed `defaultValue` on the next reload —
 * making "Reset all parameters" a no-op and letting auto-computed slider
 * ranges drift. `originalCode` is the model's first-authored source, stored
 * in message metadata; values still track the edited code, defaults track the
 * original. Falls back to the live code for older messages that predate the
 * stash.
 */
function mergeParameterDefaults(
  code: string,
  originalCode: string | undefined,
): Parameter[] {
  const parameters = parseParameters(code);
  if (!originalCode || originalCode === code) return parameters;
  const defaults = new Map(
    parseParameters(originalCode).map((param) => [
      param.name,
      param.defaultValue,
    ]),
  );
  return parameters.map((param) =>
    defaults.has(param.name)
      ? { ...param, defaultValue: defaults.get(param.name)! }
      : param,
  );
}

function assemblyComponentsFromParts(parts: unknown): AssemblyComponent[] {
  if (!Array.isArray(parts)) return [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (
      !part ||
      typeof part !== 'object' ||
      !('type' in part) ||
      (part.type !== 'tool-build_parametric_model' &&
        part.type !== 'tool-patch_parametric_components') ||
      !('output' in part) ||
      !part.output ||
      typeof part.output !== 'object' ||
      !('components' in part.output) ||
      !Array.isArray(part.output.components)
    ) {
      continue;
    }
    return part.output.components as AssemblyComponent[];
  }
  return [];
}

function normalizeAssemblyVisibility(
  visibility: Record<string, boolean> | undefined,
  components: AssemblyComponent[],
): Record<string, boolean> {
  return Object.fromEntries(
    components.map((component) => [
      component.component_id,
      visibility?.[component.component_id] !== false,
    ]),
  );
}

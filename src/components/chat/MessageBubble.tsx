import { MeshImagePreview } from '@/components/viewer/MeshImagePreview';
import { StreamingCodeBlock } from '@/components/chat/StreamingCodeBlock';
import { ChatReasoning } from '@/components/chat/ChatReasoning';
import { UserAvatar } from '@/components/chat/UserAvatar';
import { ProviderLogo } from '@/components/ProviderLogo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PARAMETRIC_MODELS } from '@/lib/utils';
import { IrisLogo } from '@/components/iris/IrisLogo';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useImageData } from '@/hooks/useImageData';
import { useSevenViewPreview } from '@/hooks/useSevenViewPreview';
import { useProfile } from '@/services/profileService';
import type { ChatMessage } from '@/lib/aiMessages';
import type { ParametricArtifact } from '@shared/types';
import type { TreeNode } from '@shared/Tree';
import {
  cleanAssistantText,
  isParametricArtifact,
} from '@shared/parametricParts';
import { USER_BUILD_GUIDANCE_PREFIX } from '@shared/chatAi';
import { imageIdFromFilename } from '@shared/imageRefs';
import type React from 'react';
import {
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import type { Model } from '@shared/types';
import type { ModelConfig } from '@/types/misc';

type MessageBubbleProps = {
  message: TreeNode<ChatMessage>;
  isLoading: boolean;
  isLastMessage?: boolean;
  currentModel?: Model;
  /** Full source reconstructed locally for a historical patch node. */
  resolvedArtifact?: ParametricArtifact;
  onSelectLeaf?: (messageId: string) => void;
  onEditUserText?: (message: ChatMessage, text: string) => void;
  onViewArtifact?: (artifact: ParametricArtifact) => void;
  /** Tool call ids waiting for Continue before CAD compile (G1). */
  pendingBuildApprovalIds?: ReadonlySet<string>;
  /** Empty guidance runs the pending script; non-empty skips and rewrites. */
  onApproveBuild?: (toolCallId: string, guidance?: string) => void;
  onChangeRating?: (rating: number) => void;
  onRetry?: (model: Model) => void;
  onRestore?: () => void;
};

export function MessageBubble(props: MessageBubbleProps) {
  return props.message.role === 'user' ? (
    <UserBubble {...props} />
  ) : (
    <AssistantBubble {...props} />
  );
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * Prefer tool `planned_changes`; if missing while awaiting Continue, fall
 * back to the nearest prior reasoning/text (truncated).
 */
function plannedChangesForBuild(
  artifact: ParametricArtifact | undefined,
  partInput: unknown,
  messageParts: ChatMessage['parts'],
  toolPartIndex: number,
): string | null {
  const fromTool =
    artifact?.planned_changes?.trim() ||
    getStringField(partInput, 'planned_changes')?.trim() ||
    '';
  if (fromTool) return fromTool;

  for (let i = toolPartIndex - 1; i >= 0; i -= 1) {
    const prior = messageParts[i];
    if (prior.type !== 'reasoning' && prior.type !== 'text') continue;
    const text = cleanAssistantText(prior.text).trim();
    if (!text) continue;
    return text.length > 240 ? `${text.slice(0, 240).trimEnd()}…` : text;
  }
  return null;
}

function answerUserMessageText(
  part: ChatMessage['parts'][number],
): string | undefined {
  if (part.type !== 'tool-answer_user') return undefined;

  const message =
    part.state === 'output-available'
      ? part.output.message
      : part.state === 'input-streaming' || part.state === 'input-available'
        ? getStringField(part.input, 'message')
        : undefined;
  const cleaned = message ? cleanAssistantText(message).trim() : '';
  return cleaned || undefined;
}

function ReferenceFeaturesBlock({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  const preview =
    summary.length > 160 ? `${summary.slice(0, 160).trimEnd()}…` : summary;

  return (
    <div className="iris-reference-features min-w-0 overflow-hidden rounded-lg border border-[#dedee3] bg-[#f2f2f5] text-[#1d1d1f]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-[#1d1d1f] transition-colors hover:bg-[#e8e8ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7771c8]"
      >
        <span className="font-medium">Reference image features</span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-[#6e6e73]" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#6e6e73]" />
        )}
      </button>
      <div className="border-t border-[#dedee3] px-3 py-2 text-xs leading-relaxed text-[#1d1d1f]">
        {open ? (
          <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
            {summary}
          </div>
        ) : (
          <p className="line-clamp-2 whitespace-pre-wrap">{preview}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Optional chat thumbnail for the seven-view inspection sheet uploaded at
 * `preview-{toolCallId}`. Controlled by `agent_show_seven_view` — never gates
 * model-side `toModelOutput` attachment.
 */
function SevenViewThumb({
  toolCallId,
  enabled,
  inspectionRow = false,
}: {
  toolCallId: string;
  enabled: boolean;
  /** A quiet disclosure row below the CAD result, rather than an attachment. */
  inspectionRow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: url, isLoading } = useSevenViewPreview({
    toolCallId,
    enabled,
  });

  if (!enabled) return null;
  if (isLoading) {
    if (inspectionRow) {
      return (
        <div className="iris-inspection-row iris-inspection-row--loading">
          <span>Inspection</span>
          <span>Preparing 7 views…</span>
        </div>
      );
    }
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-adam-neutral-950/60',
          'h-28 w-full',
        )}
      >
        <Loader2 className="h-5 w-5 animate-spin text-adam-neutral-400" />
      </div>
    );
  }
  if (!url) return null;

  if (inspectionRow) {
    return (
      <>
        <details className="iris-inspection-row">
          <summary>
            <span>Inspection</span>
            <span>7 views</span>
            <ChevronDown aria-hidden="true" />
          </summary>
          <button
            type="button"
            className="iris-inspection-row__preview"
            onClick={() => setOpen(true)}
            aria-label="Enlarge seven-view inspection sheet"
          >
            <img
              src={url}
              alt="Seven-view inspection sheet"
              className="max-h-48 w-full object-contain"
            />
            <span>Open full inspection</span>
          </button>
        </details>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="iris-seven-view-dialog max-w-4xl p-4">
            <DialogHeader>
              <DialogTitle className="text-sm text-adam-neutral-50">
                Seven-view inspection
              </DialogTitle>
            </DialogHeader>
            <img
              src={url}
              alt="Seven-view inspection sheet (enlarged)"
              className="max-h-[80vh] w-full object-contain"
            />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className={cn('block text-left', 'w-full p-2')}
        onClick={() => setOpen(true)}
        aria-label="Enlarge seven-view inspection sheet"
      >
        <img
          src={url}
          alt="Seven-view inspection sheet"
          className={cn(
            'rounded-md bg-adam-neutral-950 object-contain',
            'max-h-40 w-full',
          )}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="iris-seven-view-dialog max-w-4xl p-4">
          <DialogHeader>
            <DialogTitle className="text-sm text-adam-neutral-50">
              Seven-view inspection
            </DialogTitle>
          </DialogHeader>
          <img
            src={url}
            alt="Seven-view inspection sheet (enlarged)"
            className="max-h-[80vh] w-full object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Renders a user-attached image by downloading it from the private `images`
 * bucket (via {@link useImageData}) rather than trusting the part's `url`.
 * The persisted `url` is only a storage reference — the bucket is private, so
 * a direct `<img src>` against it would 404. The image id comes from the file
 * part's `filename` (`${id}.png`).
 */
function UploadedImage({ id, alt }: { id: string; alt: string }) {
  const {
    data: { isError: isDataError },
    url: { data, isError: isUrlError },
  } = useImageData(id);

  if (data?.url) {
    return (
      <img
        src={data.url}
        alt={alt}
        className="h-20 w-20 rounded-lg object-cover"
      />
    );
  }

  return (
    <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-adam-neutral-900">
      {isDataError || isUrlError ? (
        <X className="h-5 w-5 text-adam-text-secondary" />
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-adam-text-secondary" />
      )}
    </div>
  );
}

function UserBubble({
  message,
  isLoading,
  onSelectLeaf,
  onEditUserText,
}: MessageBubbleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const text = useMemo(
    () =>
      message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    [message],
  );
  const [input, setInput] = useState(text);

  const imageParts = useMemo(
    () =>
      message.parts.filter(
        (p): p is Extract<(typeof message.parts)[number], { type: 'file' }> =>
          p.type === 'file' &&
          typeof p.mediaType === 'string' &&
          p.mediaType.startsWith('image/'),
      ),
    [message],
  );
  const meshContextParts = useMemo(
    () =>
      message.parts.filter(
        (
          p,
        ): p is Extract<
          (typeof message.parts)[number],
          { type: 'data-mesh-context' }
        > => p.type === 'data-mesh-context',
      ),
    [message],
  );
  const branchIndex = message.siblings.findIndex((b) => b.id === message.id);
  const leafNodes = useMemo(
    () =>
      message.siblings.map((branch) => {
        let current = branch;
        while (current.children.length > 0) current = current.children[0];
        return current;
      }),
    [message.siblings],
  );

  const handleEdit = () => {
    onEditUserText?.(message, input);
    setIsEditing(false);
  };
  const handleCancel = () => {
    setInput(text);
    setIsEditing(false);
  };
  const handleCopy = () => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
  };
  const handleMouseEnter = () => {
    setHovering(true);
    if (textareaRef.current) textareaRef.current.focus();
  };
  const handleMouseLeave = () => {
    setHovering(false);
    setCopied(false);
  };

  const hasAttachments = imageParts.length > 0 || meshContextParts.length > 0;
  const hasBubble = isEditing || text.length > 0;
  const showActions =
    (hovering &&
      (onEditUserText ||
        text ||
        (onSelectLeaf && message.siblings.length > 1))) ||
    isEditing;

  return (
    <div className="iris-user-message flex w-full min-w-0 max-w-full flex-row-reverse justify-start">
      <div className="ml-2 mt-1 shrink-0">
        <UserAvatar className="h-9 w-9 border border-adam-neutral-700 bg-adam-neutral-950 p-0" />
      </div>
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="relative flex flex-col gap-1"
      >
        {hasAttachments ? (
          <div className="flex flex-wrap gap-1">
            {imageParts.map((part, index) => {
              // Legacy/freshly-streamed parts may still carry an inline data
              // URL — render those directly. Everything else is a storage
              // reference resolved by image id (see UploadedImage).
              const id = imageIdFromFilename(part.filename);
              if (part.url?.startsWith('data:') || !id) {
                return (
                  <img
                    key={`img-${index}`}
                    src={part.url}
                    alt={part.filename ?? 'Uploaded image'}
                    className="h-20 w-20 rounded-lg object-cover"
                  />
                );
              }
              return (
                <UploadedImage
                  key={`img-${index}`}
                  id={id}
                  alt={part.filename ?? 'Uploaded image'}
                />
              );
            })}
            {meshContextParts.map((part, index) => (
              <MeshContextChip
                key={`mesh-${index}`}
                meshId={part.data.meshId}
                filename={part.data.filename}
                fileType={part.data.fileType}
              />
            ))}
          </div>
        ) : null}

        {hasBubble && (
          <div
            className={cn(
              'iris-user-message__bubble relative grid w-fit rounded-lg text-white',
              (hovering || hasAttachments) && 'bg-adam-neutral-800',
            )}
          >
            {isEditing && (
              <Textarea
                value={input}
                ref={textareaRef}
                onChange={(e) => setInput(e.target.value)}
                className="block h-auto min-h-0 w-full resize-none overflow-hidden whitespace-pre-line break-words border-none bg-adam-neutral-800 px-3 py-2 text-sm sm:px-4"
                rows={1}
                style={{ gridArea: '1 / -1' }}
              />
            )}
            <div
              className={cn(
                'pointer-events-none col-start-1 row-start-1 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm sm:px-4',
                isEditing ? 'opacity-0' : '',
              )}
            >
              <span>{isEditing ? input : text}</span>
              <br />
            </div>
          </div>
        )}

        {showActions && (
          <div className="absolute bottom-[-1.5rem] right-2 flex items-center gap-0.5 rounded-sm border border-adam-neutral-700 bg-adam-bg-secondary-dark p-0.5">
            {!isEditing ? (
              <>
                {onEditUserText && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'h-6 w-6 rounded-sm p-0',
                            isLoading
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-adam-neutral-800',
                          )}
                          disabled={isLoading}
                          onClick={() => setIsEditing(true)}
                        >
                          <Pencil className="h-3 w-3 p-0 text-adam-neutral-100" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit</TooltipContent>
                    </Tooltip>
                    <Separator
                      orientation="vertical"
                      className="h-4 bg-adam-neutral-700"
                    />
                  </>
                )}
                {text && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 rounded-sm p-0 hover:bg-adam-neutral-800"
                        onClick={handleCopy}
                      >
                        {copied ? (
                          <Check className="h-3 w-3 p-0 text-adam-neutral-100" />
                        ) : (
                          <Copy className="h-3 w-3 p-0 text-adam-neutral-100" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy Prompt</TooltipContent>
                  </Tooltip>
                )}
                {onSelectLeaf && message.siblings.length > 1 && (
                  <>
                    <Separator
                      orientation="vertical"
                      className="h-4 bg-adam-neutral-700"
                    />
                    <BranchNavigation
                      branchCount={message.siblings.length}
                      branchIndex={branchIndex}
                      isLoading={isLoading}
                      onPrev={() => onSelectLeaf(leafNodes[branchIndex - 1].id)}
                      onNext={() => onSelectLeaf(leafNodes[branchIndex + 1].id)}
                    />
                  </>
                )}
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleEdit}
                  className="h-6 w-6 rounded-sm p-0 hover:bg-adam-blue"
                >
                  <Check className="h-3 w-3 p-0 text-adam-neutral-100" />
                </Button>
                <Separator
                  orientation="vertical"
                  className="h-4 bg-adam-neutral-700"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-sm p-0 hover:bg-adam-neutral-800"
                  onClick={handleCancel}
                >
                  <X className="h-3 w-3 p-0 text-adam-neutral-100" />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantBubble({
  message,
  isLoading,
  isLastMessage = false,
  currentModel,
  resolvedArtifact,
  onSelectLeaf,
  onViewArtifact,
  pendingBuildApprovalIds,
  onApproveBuild,
  onChangeRating,
  onRetry,
  onRestore,
}: MessageBubbleProps) {
  const { data: profile } = useProfile();
  const showSevenView = profile?.agent_show_seven_view === true;
  const modelOptions = PARAMETRIC_MODELS;
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [approvalGuidanceByToolId, setApprovalGuidanceByToolId] = useState<
    Record<string, string>
  >({});
  const lastParametricMutationIndex = useMemo(() => {
    let buildIndex = -1;
    message.parts.forEach((part, index) => {
      if (
        part.type === 'tool-build_parametric_model' ||
        part.type === 'tool-patch_parametric_components'
      ) {
        buildIndex = index;
      }
    });
    return buildIndex;
  }, [message.parts]);

  const text = useMemo(
    () =>
      lastParametricMutationIndex !== -1
        ? ''
        : message.parts
            .filter(
              (
                p,
              ): p is Extract<
                (typeof message.parts)[number],
                { type: 'text' }
              > => p.type === 'text',
            )
            .map((p) => cleanAssistantText(p.text))
            .filter((visibleText) => !!visibleText)
            .join(''),
    [message, lastParametricMutationIndex],
  );
  const answerText = useMemo(
    () => message.parts.map(answerUserMessageText).filter(Boolean).join(''),
    [message],
  );
  const copyText = answerText || text;
  const hasAnswerUserMessage = useMemo(
    () => message.parts.some((part) => !!answerUserMessageText(part)?.trim()),
    [message],
  );
  const branchIndex = message.siblings.findIndex((b) => b.id === message.id);
  const leafNodes = useMemo(
    () =>
      message.siblings.map((branch) => {
        let current = branch;
        while (current.children.length > 0) current = current.children[0];
        return current;
      }),
    [message.siblings],
  );

  const toggleTool = (index: number) => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="iris-assistant-message flex min-w-0 max-w-full justify-start">
      <div className="mr-2 mt-1 shrink-0">
        <div className="grid h-9 w-9 place-items-center rounded-full border border-adam-neutral-700 bg-adam-neutral-950 p-1.5">
          <IrisLogo className="h-full w-full" alt="Iris" />
        </div>
      </div>
      <div className="flex min-w-0 max-w-[calc(100%-3rem)] flex-1 flex-col gap-2">
        {message.parts.map((part, index) => {
          if (part.type === 'text') {
            if (lastParametricMutationIndex !== -1) {
              return null;
            }
            const visibleText = cleanAssistantText(part.text);
            if (hasAnswerUserMessage || !visibleText) {
              return null;
            }
            return (
              <div
                key={index}
                className="iris-assistant-message__copy chat-markdown min-w-0 max-w-full overflow-hidden rounded-lg bg-adam-neutral-800 px-3 py-2 text-sm text-adam-text-primary"
              >
                <Streamdown parseIncompleteMarkdown>{visibleText}</Streamdown>
              </div>
            );
          }

          if (part.type === 'reasoning') {
            if (!part.text) return null;
            // IrisCAD-tailored wrapper around ai-elements' Reasoning primitive
            // — adds a capped-height scroll body with auto-pin-to-bottom
            // while the model is still streaming reasoning tokens.
            return (
              <ChatReasoning
                key={index}
                text={part.text}
                isStreaming={part.state === 'streaming'}
              />
            );
          }

          if (part.type === 'data-reference-features') {
            return (
              <ReferenceFeaturesBlock key={index} summary={part.data.summary} />
            );
          }

          if (part.type === 'tool-build_parametric_model') {
            if (index !== lastParametricMutationIndex) return null;
            const artifact =
              part.state !== 'input-streaming' &&
              isParametricArtifact(part.input)
                ? part.input
                : undefined;
            const compileOutput =
              part.state === 'output-available' ? part.output : undefined;
            const isCompileError =
              part.state === 'output-error' ||
              compileOutput?.status === 'error';
            const isGuidanceSkip =
              compileOutput?.status === 'error' &&
              compileOutput.message.startsWith(USER_BUILD_GUIDANCE_PREFIX);
            const errorDisplayText =
              part.state === 'output-error'
                ? part.errorText
                : compileOutput?.status === 'error'
                  ? [
                      compileOutput.message,
                      compileOutput.errorGuidance
                        ? `what_happened: ${compileOutput.errorGuidance.what_happened}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join('\n')
                  : null;
            // While the model is mid-stream, render the SCAD code in a
            // typewriter-style block so the user sees something happening
            // (matches legacy AssistantMessage's StreamingCodeBlock branch).
            // `part.input` is a partial object during streaming — pull off
            // whatever `code` has arrived so far.
            const partialCode =
              part.state === 'input-streaming'
                ? (getStringField(part.input, 'code') ?? '')
                : '';
            if (part.state === 'input-streaming') {
              return (
                <StreamingCodeBlock
                  key={index}
                  code={partialCode}
                  isStreaming={true}
                />
              );
            }

            const isOpen = expandedTools.has(index);
            const awaitingApproval =
              part.state === 'input-available' &&
              (pendingBuildApprovalIds?.has(part.toolCallId) ?? false);
            const plannedChanges = awaitingApproval
              ? plannedChangesForBuild(
                  artifact,
                  part.input,
                  message.parts,
                  index,
                )
              : null;
            const showSevenViewThumb =
              showSevenView &&
              part.state === 'output-available' &&
              compileOutput?.status === 'success' &&
              compileOutput.inspection?.imageAttached === true;
            // Spinner while `input-available` = browser still compiling /
            // attaching seven-view before `addToolOutput` — except when we
            // are gated on Continue (do not fake a compile spinner).
            // Chat seven-view thumbnail is opt-in via profile; model still
            // receives the sheet via `toModelOutput` either way.
            return (
              <ToolBlock
                key={index}
                icon={<Box className="h-4 w-4" />}
                title={
                  awaitingApproval
                    ? artifact?.title
                      ? `${artifact.title} — ready to build`
                      : 'Ready to build CAD'
                    : isGuidanceSkip
                      ? 'Revision skipped — rewriting from guidance'
                      : isCompileError
                        ? 'CAD generation failed'
                        : artifact
                          ? artifact.title
                          : 'Building CAD...'
                }
                loading={part.state === 'input-available' && !awaitingApproval}
                headerAction={
                  awaitingApproval && onApproveBuild ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="dark"
                      className="my-1.5 mr-1 h-7 shrink-0 rounded-full px-3 text-xs"
                      onClick={() =>
                        onApproveBuild(
                          part.toolCallId,
                          approvalGuidanceByToolId[part.toolCallId],
                        )
                      }
                    >
                      Continue
                    </Button>
                  ) : null
                }
                expanded={isOpen}
                onToggle={() => toggleTool(index)}
                onPrimary={
                  artifact && !awaitingApproval
                    ? () => onViewArtifact?.(artifact)
                    : undefined
                }
                previewBody={
                  awaitingApproval ? (
                    <div className="space-y-2 p-3">
                      {plannedChanges ? (
                        <div className="text-xs leading-relaxed text-adam-neutral-200">
                          <div className="mb-1 font-medium text-adam-neutral-50">
                            Planned changes
                          </div>
                          <p className="whitespace-pre-wrap break-words">
                            {plannedChanges}
                          </p>
                        </div>
                      ) : null}
                      <Textarea
                        value={approvalGuidanceByToolId[part.toolCallId] ?? ''}
                        onChange={(e) =>
                          setApprovalGuidanceByToolId((current) => ({
                            ...current,
                            [part.toolCallId]: e.target.value,
                          }))
                        }
                        placeholder={
                          showSevenView
                            ? 'Optional: what to change with respect to the seven-view preview…'
                            : 'Optional: what to change…'
                        }
                        className="min-h-[72px] resize-y rounded-md border-adam-neutral-700 bg-adam-background-1 text-xs text-adam-neutral-100 placeholder:text-adam-neutral-400"
                      />
                    </div>
                  ) : null
                }
                footerBody={
                  showSevenViewThumb ? (
                    <SevenViewThumb
                      toolCallId={part.toolCallId}
                      enabled={showSevenViewThumb}
                      inspectionRow
                    />
                  ) : null
                }
              >
                {errorDisplayText && !isGuidanceSkip ? (
                  <div className="border-b border-adam-neutral-700 p-3 text-xs text-red-300">
                    {errorDisplayText}
                  </div>
                ) : null}
                {isGuidanceSkip && compileOutput?.status === 'error' ? (
                  <div className="border-b border-adam-neutral-700 px-3 py-2 text-xs leading-relaxed text-adam-neutral-200">
                    {compileOutput.message}
                  </div>
                ) : null}
                {artifact?.code ? (
                  <ScrollArea className="h-80 w-full">
                    <pre className="m-0 whitespace-pre-wrap break-words p-3 text-xs text-adam-neutral-200">
                      <code>{artifact.code}</code>
                    </pre>
                  </ScrollArea>
                ) : null}
              </ToolBlock>
            );
          }

          if (part.type === 'tool-patch_parametric_components') {
            if (index !== lastParametricMutationIndex) return null;
            const compileOutput =
              part.state === 'output-available' ? part.output : undefined;
            const isCompileError =
              part.state === 'output-error' ||
              compileOutput?.status === 'error';
            const errorDisplayText =
              part.state === 'output-error'
                ? part.errorText
                : compileOutput?.status === 'error'
                  ? [
                      compileOutput.message,
                      compileOutput.errorGuidance
                        ? `what_happened: ${compileOutput.errorGuidance.what_happened}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join('\n')
                  : null;
            const isOpen = expandedTools.has(index);
            const showSevenViewThumb =
              showSevenView &&
              part.state === 'output-available' &&
              compileOutput?.status === 'success' &&
              compileOutput.inspection?.imageAttached === true;
            const updateSummary = getStringField(part.input, 'update_summary');
            return (
              <ToolBlock
                key={index}
                icon={<Box className="h-4 w-4" />}
                title={
                  isCompileError
                    ? 'Local CAD edit failed'
                    : resolvedArtifact?.title
                      ? `${resolvedArtifact.title} — local revision`
                      : 'Applying local CAD revision...'
                }
                loading={
                  part.state === 'input-streaming' ||
                  part.state === 'input-available'
                }
                expanded={isOpen}
                onToggle={() => toggleTool(index)}
                onPrimary={
                  resolvedArtifact
                    ? () => onViewArtifact?.(resolvedArtifact)
                    : undefined
                }
                footerBody={
                  showSevenViewThumb ? (
                    <SevenViewThumb
                      toolCallId={part.toolCallId}
                      enabled={showSevenViewThumb}
                      inspectionRow
                    />
                  ) : null
                }
              >
                {errorDisplayText ? (
                  <div className="border-b border-adam-neutral-700 p-3 text-xs text-red-300">
                    {errorDisplayText}
                  </div>
                ) : null}
                {updateSummary ? (
                  <div className="border-b border-adam-neutral-700 px-3 py-2 text-xs text-adam-neutral-200">
                    {updateSummary}
                  </div>
                ) : null}
                {resolvedArtifact?.code ? (
                  <ScrollArea className="h-80 w-full">
                    <pre className="m-0 whitespace-pre-wrap break-words p-3 text-xs text-adam-neutral-200">
                      <code>{resolvedArtifact.code}</code>
                    </pre>
                  </ScrollArea>
                ) : null}
              </ToolBlock>
            );
          }

          if (part.type === 'tool-answer_user') {
            const answerMessage = answerUserMessageText(part) ?? '';
            if (!answerMessage.trim()) return null;
            return (
              <div
                key={index}
                className="iris-assistant-message__copy iris-assistant-final chat-markdown min-w-0 max-w-full overflow-hidden px-1 py-2 text-sm text-adam-text-primary"
              >
                <Streamdown parseIncompleteMarkdown>{answerMessage}</Streamdown>
              </div>
            );
          }

          return null;
        })}

        {/* Suppress the rating/retry/copy/restore strip while the latest
            assistant message is still streaming — those controls don't
            make sense on a half-rendered response. Older messages keep
            their controls even during a new stream. */}
        {!(isLoading && isLastMessage) && (
          <div className="flex flex-wrap items-center gap-1 gap-y-2">
            {onChangeRating && (
              <div className="flex items-center">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => onChangeRating(message.rating === 1 ? 0 : 1)}
                  className="h-6 w-6 rounded-lg rounded-r-none border-r-0 p-0 pl-0.5"
                  aria-label="Thumbs up"
                >
                  <ThumbsUp
                    className={cn(
                      'h-3 w-3',
                      message.rating === 1
                        ? 'text-adam-blue'
                        : 'text-adam-neutral-100',
                    )}
                  />
                </Button>
                <Separator
                  orientation="vertical"
                  className="h-6 bg-adam-neutral-700"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => onChangeRating(message.rating === -1 ? 0 : -1)}
                  className="h-6 w-6 rounded-lg rounded-l-none border-l-0 p-0 pr-0.5"
                  aria-label="Thumbs down"
                >
                  <ThumbsDown
                    className={cn(
                      'h-3 w-3',
                      message.rating === -1
                        ? 'text-adam-blue'
                        : 'text-adam-neutral-100',
                    )}
                  />
                </Button>
              </div>
            )}

            {copyText && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-6 w-6 rounded-lg p-0"
                    onClick={() => navigator.clipboard.writeText(copyText)}
                    aria-label="Copy"
                  >
                    <Copy className="h-3 w-3 text-adam-neutral-100" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy</TooltipContent>
              </Tooltip>
            )}

            {onRestore && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={onRestore}
                    disabled={isLoading}
                    className="h-6 w-6 rounded-lg p-0"
                    aria-label="Restore this version"
                  >
                    <History className="h-3 w-3 text-adam-neutral-100" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Restore</TooltipContent>
              </Tooltip>
            )}

            {onRetry && message.parent_message_id && (
              <div className="flex items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() =>
                        currentModel ? onRetry(currentModel) : undefined
                      }
                      disabled={isLoading || !currentModel}
                      className={cn(
                        'h-6 w-6 rounded-lg p-0',
                        modelOptions.length > 1 && 'rounded-r-none border-r-0',
                      )}
                      aria-label="Retry"
                    >
                      <RefreshCw className="h-3 w-3 text-adam-neutral-100" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Retry</TooltipContent>
                </Tooltip>
                {modelOptions.length > 1 && (
                  <RetryModelDropdown
                    modelOptions={modelOptions}
                    selectedModelId={
                      (message.metadata?.model as Model | undefined) ??
                      currentModel
                    }
                    onRetry={onRetry}
                    disabled={isLoading}
                  />
                )}
              </div>
            )}

            {onSelectLeaf && message.siblings.length > 1 && (
              <div className="flex h-6 items-center gap-0.5 rounded-lg border border-adam-neutral-700 bg-adam-bg-secondary-dark">
                <BranchNavigation
                  branchCount={message.siblings.length}
                  branchIndex={branchIndex}
                  isLoading={isLoading}
                  onPrev={() => onSelectLeaf(leafNodes[branchIndex - 1].id)}
                  onNext={() => onSelectLeaf(leafNodes[branchIndex + 1].id)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Retry-with-another-model dropdown. Trigger shows the model that
 * produced THIS message (so the user can see what they're swapping
 * away from) with a chevron that rotates when the menu opens. Matches
 * the legacy `RetryModelSelector` shape.
 */
function RetryModelDropdown({
  modelOptions,
  selectedModelId,
  onRetry,
  disabled,
}: {
  modelOptions: ModelConfig[];
  selectedModelId: Model | undefined;
  onRetry: (model: Model) => void;
  disabled: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedModel =
    modelOptions.find((option) => option.id === selectedModelId) ??
    modelOptions[0];
  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            'h-6 w-fit gap-1 rounded-lg rounded-l-none px-2 text-xs text-adam-text-primary',
            isOpen && 'bg-adam-neutral-800',
          )}
          aria-label="Retry with another model"
        >
          <span>{selectedModel.name}</span>
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform duration-100',
              isOpen && 'rotate-180',
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-adam-neutral-700 bg-adam-neutral-800 p-1 [max-height:min(300px,var(--radix-dropdown-menu-content-available-height))]"
      >
        {modelOptions.map((option) => (
          <DropdownMenuItem
            key={option.id}
            className="cursor-pointer rounded-md bg-adam-neutral-800 px-2 py-2 text-xs text-adam-text-primary hover:bg-adam-neutral-700 focus:bg-adam-bg-secondary-dark"
            onClick={() => {
              onRetry(option.id);
              setIsOpen(false);
            }}
          >
            <div className="flex w-full items-start gap-2.5">
              <ProviderLogo
                provider={option.provider}
                className="mt-px h-3.5 w-3.5 text-adam-text-primary"
              />
              <div className="min-w-0 flex-1">
                <span className="font-medium">{option.name}</span>
                {option.description && (
                  <p className="mt-0.5 text-[11px] leading-4 text-gray-400">
                    {option.description}
                  </p>
                )}
              </div>
              {option.id === selectedModel.id && (
                <Check className="mt-px h-3.5 w-3.5 shrink-0" />
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchNavigation({
  branchCount,
  branchIndex,
  isLoading,
  onPrev,
  onNext,
}: {
  branchCount: number;
  branchIndex: number;
  isLoading: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        disabled={branchIndex === 0 || isLoading}
        className="h-6 w-6 rounded-sm p-0 hover:bg-adam-neutral-800"
        onClick={onPrev}
      >
        <ChevronLeft className="h-3 w-3 p-0 text-adam-neutral-100" />
      </Button>
      <span className="text-xs text-adam-neutral-300">
        {branchIndex + 1}/{branchCount}
      </span>
      <Button
        variant="ghost"
        size="icon"
        disabled={branchIndex === branchCount - 1 || isLoading}
        className="h-6 w-6 rounded-sm p-0 hover:bg-adam-neutral-800"
        onClick={onNext}
      >
        <ChevronRight className="h-3 w-3 p-0 text-adam-neutral-100" />
      </Button>
    </>
  );
}

function ToolBlock({
  icon,
  title,
  loading,
  expanded,
  onPrimary,
  onToggle,
  headerAction,
  previewBody,
  footerBody,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  loading: boolean;
  expanded: boolean;
  /** Whole-bar click — typically opens the artifact/mesh in the viewer pane. */
  onPrimary?: () => void;
  /** Toggles the expandable `children` body. The toggle affordance is the
   *  hover-revealed chevron on the right; clicking it does NOT bubble to the
   *  primary action. */
  onToggle: () => void;
  /** Optional right-side control (e.g. Continue before compile). */
  headerAction?: React.ReactNode;
  /** Always-visible body slot (e.g. a thumbnail preview). Independent of
   *  `expanded` — shown whenever it's provided. */
  previewBody?: React.ReactNode;
  /** Optional inspection row displayed below the result and expandable code. */
  footerBody?: React.ReactNode;
  /** Expandable body slot — only rendered when `expanded` is true. The
   *  chevron is hidden entirely when this is omitted. */
  children?: React.ReactNode;
}) {
  return (
    <div className="iris-tool-block group min-w-0 max-w-full overflow-hidden rounded-lg border border-adam-neutral-700 bg-adam-neutral-900 text-sm text-adam-text-primary">
      {previewBody ? (
        <div className="min-w-0 max-w-full overflow-hidden">{previewBody}</div>
      ) : null}
      <div
        className={cn(
          'flex w-full items-stretch hover:bg-adam-neutral-800',
          previewBody && 'border-t border-adam-neutral-700',
        )}
      >
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left',
            !onPrimary && 'cursor-default',
          )}
          onClick={onPrimary}
          disabled={!onPrimary}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <span className="shrink-0">{icon}</span>
          )}
          <span className="iris-tool-block__title min-w-0 flex-1 break-words leading-5">
            {title}
          </span>
        </button>
        {headerAction}
        {children ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? 'Hide code' : 'Show code'}
            className={cn(
              'flex w-9 shrink-0 items-center justify-center opacity-100 transition-opacity focus-visible:opacity-100',
            )}
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        ) : null}
      </div>
      {expanded && children ? (
        <div className="min-w-0 max-w-full overflow-hidden border-t border-adam-neutral-700">
          {children}
        </div>
      ) : null}
      {footerBody ? (
        <div className="iris-tool-block__footer">{footerBody}</div>
      ) : null}
    </div>
  );
}

// Full AI SDK v6 tool-state union. The `approval-*` and `output-denied`
// states only fire when a tool opts into approval gating via
// `needsApproval` — our tools don't, so those branches are
function MeshContextChip({
  meshId,
  filename,
  fileType,
}: {
  meshId: string;
  filename?: string;
  fileType: string;
}) {
  const label = filename ?? `mesh ${meshId.slice(0, 6)}`;
  return (
    <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-adam-neutral-700 bg-adam-neutral-900 p-1.5">
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md">
        <MeshImagePreview meshId={meshId} />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-adam-text-primary">
          {label}
        </span>
        <span className="text-xs text-adam-text-secondary">
          {fileType.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

import { useNavigate } from '@tanstack/react-router';
import { Code2, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { supabase, ssoProvider } from '@/lib/supabase';
import { signInWithSsoProvider } from '@/lib/ssoAuth';
import TextAreaChat from '@/components/TextAreaChat';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useState, useMemo, useEffect } from 'react';
import type { Conversation, Message, Model } from '@shared/types';
import { MessageItem } from '../types/misc.ts';
import { useWarmSimpleCadWorker } from '@/hooks/useWarmSimpleCadWorker';
import { cn } from '@/lib/utils';
import { SelectedItemsContext } from '@/contexts/SelectedItemsContext';
import posthog from 'posthog-js';
import * as Sentry from '@sentry/react';
import { useProfile } from '@/services/profileService';
import { apiUrl } from '@/services/api';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';
import { createAndCacheAiChat } from '@/hooks/useCachedAiChat';
import type { AppUIMessage } from '@shared/chatAi';
import { ensureInputRecords } from '@/lib/aiMessages';
import { persistUserMessage } from '@/services/messageService';
import {
  createConversationFromParametricSeed,
  loadParametricSeedFromConversation,
  prepareImportedParametricSeed,
} from '@/services/parametricSeedService';

type PastParametricCreation = Pick<
  Conversation,
  'id' | 'title' | 'updated_at' | 'current_message_leaf_id'
>;

export function PromptView() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, billing, isLoading } = useAuth();
  useWarmSimpleCadWorker(!!user);
  const totalTokens = billing?.tokens.total ?? 0;
  const { data: profile, isLoading: isProfileLoading } = useProfile();
  const queryClient = useQueryClient();

  const firstName = useMemo(() => {
    // Wait until the profile query resolves for signed-in users so the
    // greeting doesn't flash the email local-part before snapping to the
    // real first name.
    if (user && isProfileLoading) return '';
    const source = profile?.full_name || user?.email?.split('@')[0] || '';
    return source.trim().split(/\s+/)[0] || '';
  }, [profile?.full_name, user, isProfileLoading]);

  const [continueDialogOpen, setContinueDialogOpen] = useState(false);
  const [continueSource, setContinueSource] = useState<'past' | 'import'>(
    'past',
  );
  const [importCode, setImportCode] = useState('');

  const [model, setModel] = useState<Model>('openai/gpt-5.6-sol');

  const [isLoaded, setIsLoaded] = useState(false);
  const [typedSubtitle, setTypedSubtitle] = useState('');
  const irisSubtitle = user
    ? 'How can I help you today?'
    : 'Sign in to start creating!';
  const [images, setImages] = useState<MessageItem[]>([]);
  const [mesh, setMesh] = useState<MessageItem | null>(null);

  const [draftConversationId, setDraftConversationId] = useState(() =>
    crypto.randomUUID(),
  );

  const pastCreationsQuery = useQuery<PastParametricCreation[]>({
    queryKey: ['parametric-seed-creations', user?.id],
    enabled: continueDialogOpen && !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('id,title,updated_at,current_message_leaf_id')
        .eq('user_id', user?.id ?? '')
        .eq('type', 'parametric')
        .not('current_message_leaf_id', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(30)
        .overrideTypes<PastParametricCreation[]>();
      if (error) throw error;
      return data ?? [];
    },
  });

  const lowPrompts = useMemo(() => {
    if (isLoading) return false;
    return totalTokens > 0 && totalTokens <= 10;
  }, [totalTokens, isLoading]);

  const limitReached = useMemo(() => {
    if (isLoading) return false;
    return totalTokens <= 0;
  }, [totalTokens, isLoading]);

  // Trigger fade in on mount
  useEffect(() => {
    // Use requestAnimationFrame to ensure the initial render is complete
    const frame = requestAnimationFrame(() => {
      setIsLoaded(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    const subtitle = irisSubtitle;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTypedSubtitle(subtitle);
      return;
    }

    setTypedSubtitle('');
    let characterIndex = 0;
    let typingTimer: number | undefined;
    const startTimer = window.setTimeout(() => {
      typingTimer = window.setInterval(() => {
        characterIndex += 1;
        setTypedSubtitle(subtitle.slice(0, characterIndex));
        if (characterIndex === subtitle.length) {
          window.clearInterval(typingTimer);
        }
      }, 68);
    }, 1700);

    return () => {
      window.clearTimeout(startTimer);
      if (typingTimer !== undefined) window.clearInterval(typingTimer);
    };
  }, [irisSubtitle, isLoaded]);

  // In SSO mode the provider redirect IS the sign-in: the existing signed-out
  // affordances below fire it directly instead of navigating to the native
  // auth routes (which bounce back to root in this mode). Same UI, same
  // pixels — only where the click goes changes.
  const { mutate: signInWithSso } = useMutation({
    mutationFn: () => signInWithSsoProvider('/'),
    onError: (error) => {
      toast({
        title: 'Whoopsies',
        description:
          error instanceof Error ? error.message : 'Something went wrong',
        variant: 'destructive',
      });
    },
  });

  const { mutate: handleGenerate, isPending: isGenerating } = useMutation({
    mutationFn: async (parts: AppUIMessage['parts']) => {
      if (!user?.id) throw new Error('User must be authenticated');
      const conversationId = draftConversationId;

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

      posthog.capture('new_conversation', {
        type: 'parametric',
        model_name: model,
        text: text.trim().slice(0, 100),
        image_count: imageCount,
        mesh_count: meshCount,
        conversation_id: conversationId,
      });

      // Create conversation immediately with 'New Conversation'
      const { data: conversation, error: conversationError } = await supabase
        .from('conversations')
        .insert([
          {
            id: conversationId,
            user_id: user.id,
            title: 'New Conversation',
            type: 'parametric',
            settings: {
              model: model,
            },
          },
        ])
        .select()
        .single();

      if (conversationError) throw conversationError;

      await ensureInputRecords({
        parts,
        conversationId: conversation.id,
        userId: user.id,
      });
      if (parts.length === 0) throw new Error('No message parts to send');

      // Persist the user message before kicking off the chat. The
      // `update_leaf_trigger` on `public.messages` advances the
      // conversation's `current_message_leaf_id` to this row, which is
      // what the server-side chat handler walks to build the model
      // branch — so the row has to land first.
      const userMessageId = await persistUserMessage({
        conversationId: conversation.id,
        parts,
        metadata: { model },
        parentMessageId: null,
      });

      // Hydrate the Editor's two route-level queries before navigation. This
      // makes its first frame the real workspace instead of the legacy query
      // loading fallback while the just-created conversation is fetched again.
      const { data: initialMessages, error: initialMessagesError } =
        await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', conversation.id)
          .order('created_at', { ascending: true })
          .overrideTypes<Message[]>();
      if (initialMessagesError) throw initialMessagesError;
      queryClient.setQueryData(['conversation', conversation.id], {
        ...conversation,
        current_message_leaf_id: userMessageId,
      });
      queryClient.setQueryData(
        ['messages', conversation.id],
        initialMessages ?? [],
      );

      const chat = createAndCacheAiChat({
        id: conversation.id,
        generateId: () => crypto.randomUUID(),
        messages: [],
        transport: new DefaultChatTransport<AppUIMessage>({
          api: apiUrl('parametric-chat'),
          headers: async (): Promise<Record<string, string>> => {
            const accessToken = (await supabase.auth.getSession()).data.session
              ?.access_token;
            const headers: Record<string, string> = {};
            if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
            return headers;
          },
          prepareSendMessagesRequest: ({ body }) => ({
            body: {
              conversationId: conversation.id,
              model,
              ...(body ?? {}),
            },
          }),
        }),
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      });
      void chat
        .sendMessage({ id: userMessageId, parts, metadata: { model } })
        .catch((error) => {
          Sentry.captureException(error, {
            extra: {
              hook: 'PromptView initial chat',
              conversationId: conversation.id,
            },
          });
        });

      return {
        conversationId: conversation.id,
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate({ to: '/editor/$id', params: { id: data.conversationId } });
    },
    onError: (error) => {
      setDraftConversationId(crypto.randomUUID());
      Sentry.captureException(error);
      toast({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to process prompt',
        variant: 'destructive',
      });
    },
  });

  const { mutate: continuePastCreation, isPending: isContinuingPast } =
    useMutation({
      mutationFn: async (source: PastParametricCreation) => {
        if (!user?.id) throw new Error('User must be authenticated');
        const seed = await loadParametricSeedFromConversation({
          conversationId: source.id,
          leafId: source.current_message_leaf_id,
        });
        return createConversationFromParametricSeed({
          userId: user.id,
          model,
          title: source.title,
          seed,
          origin: {
            kind: 'past_creation',
            sourceConversationId: source.id,
            sourceModelRevision: seed.sourceModelRevision,
            sourceTitle: source.title,
          },
        });
      },
      onSuccess: (conversationId) => {
        setContinueDialogOpen(false);
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
        navigate({ to: '/editor/$id', params: { id: conversationId } });
      },
      onError: (error) => {
        toast({
          title: 'Could not continue this model',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      },
    });

  const { mutate: importParametricCode, isPending: isImportingCode } =
    useMutation({
      mutationFn: async () => {
        if (!user?.id) throw new Error('User must be authenticated');
        const conversationId = crypto.randomUUID();
        const seed = await prepareImportedParametricSeed({
          code: importCode,
          sessionId: conversationId,
        });
        return createConversationFromParametricSeed({
          userId: user.id,
          model,
          title: seed.artifact.title,
          seed,
          origin: { kind: 'imported_code' },
          conversationId,
        });
      },
      onSuccess: (conversationId) => {
        setContinueDialogOpen(false);
        setImportCode('');
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
        navigate({ to: '/editor/$id', params: { id: conversationId } });
      },
      onError: (error) => {
        toast({
          title: 'SimpleCADAPI import failed',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      },
    });

  return (
    <div className="iris-prompt-page relative h-full min-h-full w-full transition-all duration-300 ease-in-out">
      <div className="iris-prompt-surface h-full min-h-full">
        <main className="iris-prompt-main relative flex h-full w-full flex-col items-center justify-center px-4 md:px-8">
          <div
            className={cn(
              'mx-auto flex max-w-3xl flex-col items-center justify-center',
              'iris-prompt-heading',
              isLoaded && 'is-loaded',
            )}
          >
            <div className="relative flex flex-col items-center">
              <h1
                className={cn(
                  'iris-prompt-title mb-8 text-center text-2xl font-medium text-adam-text-primary md:text-3xl lg:text-4xl',
                  'motion-safe:transition-opacity motion-safe:duration-1000 motion-safe:ease-out',
                  isLoaded ? 'opacity-100' : 'opacity-0',
                )}
              >
                {user
                  ? `Hello ${firstName || 'there'}`
                  : 'Hello, Iris is here.'}
              </h1>
            </div>
            <>
              <p className="iris-prompt-subtitle">
                <span className="sr-only">{irisSubtitle}</span>
                <span
                  className={cn(
                    'iris-prompt-subtitle__typed',
                    typedSubtitle.length > 0 &&
                      typedSubtitle.length < irisSubtitle.length &&
                      'is-typing',
                  )}
                  aria-hidden="true"
                >
                  {typedSubtitle}
                </span>
              </p>
              <div className="iris-prompt-grid-stage" aria-hidden="true">
                <div className="iris-prompt-projection" />
                <div className="iris-prompt-grid" />
              </div>
            </>
          </div>
          <div
            className={cn(
              'flex w-full flex-col items-center',
              'iris-prompt-content',
            )}
          >
            <div
              className={cn(
                'w-full max-w-3xl space-y-4 pb-12',
                'iris-prompt-stack',
              )}
            >
              <div
                className={cn(
                  'flex justify-center gap-2',
                  'iris-prompt-start-options',
                )}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-pressed="true"
                  className="iris-prompt-start-option is-active"
                >
                  Start from Scratch
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setContinueDialogOpen(true)}
                  className="iris-prompt-start-option"
                >
                  Continue with a Model
                </Button>
              </div>
              <SelectedItemsContext.Provider
                value={{ images, setImages, mesh, setMesh }}
              >
                <TextAreaChat
                  onSubmit={handleGenerate}
                  conversation={{
                    id: draftConversationId,
                    user_id: user?.id ?? '',
                  }}
                  onFocus={() => {
                    if (!user) {
                      if (ssoProvider) {
                        signInWithSso();
                        return;
                      }
                      navigate({ to: '/signin' });
                      return;
                    }
                  }}
                  placeholder="Ask something..."
                  disabled={!user || limitReached || isGenerating}
                  model={model}
                  setModel={setModel}
                  showPromptGenerator={false}
                />
              </SelectedItemsContext.Provider>
              <div className="iris-prompt-notice-region relative">
                {isLoading && (
                  <div className="absolute left-0 right-0 top-0">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-adam-blue border-t-transparent" />
                  </div>
                )}
                {!isLoading && user && limitReached && (
                  <div className="absolute left-0 right-0 top-0">
                    <p className="py-3 text-center text-sm text-[#6e6e73]">
                      Your Iris Credits are used up.
                    </p>
                  </div>
                )}
                {!isLoading && user && lowPrompts && !limitReached && (
                  <div className="absolute left-0 right-0 top-0">
                    <p className="py-3 text-center text-sm text-[#6e6e73]">
                      {totalTokens} Iris Credit{totalTokens === 1 ? '' : 's'}{' '}
                      remaining.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      <Dialog open={continueDialogOpen} onOpenChange={setContinueDialogOpen}>
        <DialogContent className="iris-seed-dialog max-w-2xl border-adam-neutral-700 bg-adam-bg-secondary-dark text-adam-text-primary">
          <DialogHeader>
            <DialogTitle className="iris-seed-title">
              Continue with a Model
            </DialogTitle>
            <DialogDescription className="sr-only">
              Start a clean Parametric session from a successful creation or
              verified SimpleCADAPI code.
            </DialogDescription>
          </DialogHeader>

          <div className="iris-seed-tabs flex gap-2">
            <Button
              type="button"
              variant={continueSource === 'past' ? 'secondary' : 'outline'}
              onClick={() => setContinueSource('past')}
              className={cn(
                'iris-seed-tab',
                continueSource === 'past' && 'is-active',
              )}
            >
              <span className="iris-seed-tab__label">
                <History className="mr-2 h-4 w-4" />
                Continue with Your Past Creations
              </span>
            </Button>
            <Button
              type="button"
              variant={continueSource === 'import' ? 'secondary' : 'outline'}
              onClick={() => setContinueSource('import')}
              className={cn(
                'iris-seed-tab',
                continueSource === 'import' && 'is-active',
              )}
            >
              <span className="iris-seed-tab__label">
                <Code2 className="mr-2 h-4 w-4" />
                Import SimpleCADAPI Code
              </span>
            </Button>
          </div>

          {continueSource === 'past' ? (
            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {pastCreationsQuery.isLoading ? (
                <p className="py-6 text-center text-sm text-adam-text-secondary">
                  Loading your Parametric creations...
                </p>
              ) : pastCreationsQuery.isError ? (
                <p className="py-6 text-center text-sm text-red-300">
                  Could not load your past creations.
                </p>
              ) : pastCreationsQuery.data?.length ? (
                pastCreationsQuery.data.map((creation) => (
                  <button
                    key={creation.id}
                    type="button"
                    disabled={isContinuingPast}
                    onClick={() => continuePastCreation(creation)}
                    className="flex w-full items-center justify-between rounded-lg border border-adam-neutral-700 px-4 py-3 text-left hover:bg-adam-neutral-900 disabled:opacity-50"
                  >
                    <span className="truncate pr-4 text-sm font-medium">
                      {creation.title}
                    </span>
                    <span className="shrink-0 text-xs text-adam-text-secondary">
                      {creation.updated_at
                        ? new Date(creation.updated_at).toLocaleDateString()
                        : ''}
                    </span>
                  </button>
                ))
              ) : (
                <p className="py-6 text-center text-sm text-adam-text-secondary">
                  No successful Parametric creations are available yet.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <Textarea
                value={importCode}
                onChange={(event) => setImportCode(event.target.value)}
                placeholder={'import simplecadapi as scad\n\nresult = ...'}
                className="iris-seed-code-input min-h-72 resize-y border-adam-neutral-700 bg-adam-neutral-950 font-mono text-xs"
              />
              <Button
                type="button"
                className="iris-seed-validate w-full"
                disabled={!importCode.trim() || isImportingCode}
                onClick={() => importParametricCode()}
              >
                {isImportingCode
                  ? 'Validating Code...'
                  : 'Validate and Continue'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

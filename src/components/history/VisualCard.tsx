import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Clock,
  MessageSquare,
  MoreVertical,
  Trash2,
  Pencil,
  LockKeyhole,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { formatDistanceToNow } from 'date-fns';
import { HistoryConversation } from '../../types/misc.ts';
import { GoodEarth } from '../icons/ui/GoodEarth';
import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';
import { asParametricParts } from '@shared/parametricParts';

interface VisualCardProps {
  conversation: HistoryConversation;
  onDelete: (conversationId: string) => void;
  onRename: (conversationId: string, newTitle: string) => void;
  onTogglePrivacy: (
    conversationId: string,
    newPrivacy: 'public' | 'private',
  ) => void;
}

type VisualPreview = { type: 'artifact'; key: string } | null;

export function VisualCard({
  conversation,
  onDelete,
  onRename,
  onTogglePrivacy,
}: VisualCardProps) {
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { rootMargin: '100px' },
    );
    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  const { data: preview } = useQuery<VisualPreview>({
    queryKey: ['conversation-latest-preview', conversation.id],
    enabled: isVisible,
    queryFn: async () => {
      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, parts')
        .eq('conversation_id', conversation.id)
        .eq('role', 'assistant')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      for (const message of messages ?? []) {
        const latest = findLatestVisualPreview(message.parts, message.id);
        if (latest) return latest;
      }
      return null;
    },
    staleTime: 60_000,
  });

  const { data: thumbnailUrl } = useQuery<string | null>({
    queryKey: ['stored-parametric-preview', conversation.id, preview?.key],
    enabled: isVisible && !!preview,
    queryFn: async () => {
      if (!preview) return null;
      const path = `${conversation.user_id}/${conversation.id}/preview-${preview.key}`;
      const { data, error } = await supabase.storage
        .from('images')
        .download(path);
      if (error || !data) return null;
      return blobToDataUrl(data);
    },
    staleTime: Infinity,
    retry: false,
  });

  return (
    <div
      ref={cardRef}
      className="group relative overflow-hidden rounded-xl border-2 border-adam-neutral-700 bg-adam-background-2 transition-all duration-200 hover:border-adam-blue hover:shadow-[0_0_20px_rgba(0,166,255,0.3)]"
    >
      <Link to="/editor/$id" params={{ id: conversation.id }}>
        <div className="iris-history-visual-preview relative aspect-square w-full overflow-hidden">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={conversation.title}
              className="iris-history-visual-preview__iso"
              loading="lazy"
            />
          ) : (
            <div
              className="iris-history-visual-preview__empty"
              aria-label="No successful build preview available"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-adam-background-2/90 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
        </div>

        <div className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="line-clamp-2 text-base font-medium text-adam-neutral-50">
              {conversation.title}
            </h3>
            {conversation.privacy === 'public' ? (
              <GoodEarth className="h-3.5 w-3.5 shrink-0 text-adam-neutral-400" />
            ) : (
              <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-adam-neutral-400" />
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-adam-neutral-400">
            <span className="flex items-center">
              <Clock className="mr-1 h-3 w-3" />
              {formatDistanceToNow(new Date(conversation.updated_at), {
                addSuffix: true,
              })}
            </span>
            <span className="flex items-center">
              <MessageSquare className="mr-1 h-3 w-3" />
              {conversation.message_count}
            </span>
          </div>
        </div>
      </Link>

      <div className="absolute right-2 top-2">
        <AlertDialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="iris-history-overflow-trigger h-8 w-8 rounded-full bg-adam-background-1/80 p-0 backdrop-blur-sm transition-colors duration-200 hover:bg-adam-neutral-950"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-4 w-4 text-adam-neutral-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="iris-history-menu">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onRename(conversation.id, conversation.title);
                }}
                className="text-adam-neutral-50 hover:cursor-pointer hover:bg-adam-neutral-950 focus:bg-adam-neutral-950"
              >
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
              {conversation.privacy === 'private' ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePrivacy(conversation.id, 'public');
                  }}
                  className="text-adam-neutral-50 hover:cursor-pointer hover:bg-adam-neutral-950 focus:bg-adam-neutral-950"
                >
                  <GoodEarth className="mr-2 h-4 w-4" />
                  Make Public
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePrivacy(conversation.id, 'private');
                  }}
                  className="text-adam-neutral-50 hover:cursor-pointer hover:bg-adam-neutral-950 focus:bg-adam-neutral-950"
                >
                  <LockKeyhole className="mr-2 h-4 w-4" />
                  Make Private
                </DropdownMenuItem>
              )}
              <AlertDialogTrigger asChild onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem className="text-adam-neutral-50 hover:cursor-pointer hover:bg-adam-neutral-950 hover:text-red-500 focus:bg-adam-neutral-950 focus:text-red-500">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </AlertDialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialogContent className="border-[2px] border-adam-neutral-700 bg-adam-background-1">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-adam-neutral-100">
                Delete Creation
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this creation? This action
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conversation.id);
                }}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function findLatestVisualPreview(
  parts: unknown,
  messageId: string,
): VisualPreview {
  const messageParts = asParametricParts(parts);
  for (let index = messageParts.length - 1; index >= 0; index -= 1) {
    const part = messageParts[index];
    if (
      part.type === 'tool-build_parametric_model' ||
      part.type === 'tool-patch_parametric_components'
    ) {
      if (
        part.state === 'output-available' &&
        part.output.status === 'success'
      ) {
        const key =
          'toolCallId' in part && typeof part.toolCallId === 'string'
            ? part.toolCallId
            : messageId;
        return { type: 'artifact', key };
      }
    }
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

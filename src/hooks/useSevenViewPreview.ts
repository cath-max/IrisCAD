import { useConversation } from '@/contexts/ConversationContext';
import { supabase } from '@/lib/supabase';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

/**
 * Download the CAD seven-view sheet already uploaded at
 * `images/{userId}/{conversationId}/preview-{toolCallId}`.
 * Does not generate or re-upload — missing files yield `null`.
 */
export function useSevenViewPreview({
  toolCallId,
  enabled = true,
}: {
  toolCallId: string | undefined;
  enabled?: boolean;
}): UseQueryResult<string | null> {
  const { conversation } = useConversation();
  const userId = conversation.user_id;
  const conversationId = conversation.id;

  return useQuery({
    queryKey: ['seven-view-preview', conversationId, toolCallId],
    queryFn: async (): Promise<string | null> => {
      if (!userId || !toolCallId) return null;
      const storagePath = `${userId}/${conversationId}/preview-${toolCallId}`;
      const { data, error } = await supabase.storage
        .from('images')
        .download(storagePath);
      if (error || !data) return null;
      return blobToDataUrl(data);
    },
    enabled: enabled && !!userId && !!toolCallId,
    staleTime: Infinity,
    retry: false,
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

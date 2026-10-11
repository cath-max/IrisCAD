import { useAuth } from '@/contexts/AuthContext';
import { useProfile, useAvatarUrl } from '@/services/profileService';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials } from '@/lib/utils';
import { ssoClaims, ssoManaged } from '@/lib/supabase';

export function UserAvatar({ className }: { className?: string }) {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { data: avatarUrl } = useAvatarUrl(profile?.avatar_path);

  // The provider photo. Under SSO read it from the fresh identity claims (the
  // same source as the name) — NOT user_metadata, which GoTrue leaves stale. In
  // self-host, fall back to whatever the OAuth provider put in user_metadata.
  const claims = ssoClaims(user);
  const metadata = user?.user_metadata as
    | { avatar_url?: string; picture?: string }
    | undefined;
  const providerAvatar = claims
    ? claims.picture || claims.avatar_url
    : metadata?.avatar_url || metadata?.picture;

  // When an identity provider owns the profile (shared `ssoManaged` flag), its
  // photo is the source of truth so a stale local upload cannot diverge. In
  // self-host mode the self-uploaded avatar wins.
  const src = ssoManaged
    ? providerAvatar || avatarUrl || undefined
    : avatarUrl || providerAvatar || undefined;

  return (
    <Avatar className={className}>
      <AvatarImage src={src} />
      <AvatarFallback>{getInitials(profile?.full_name || null)}</AvatarFallback>
    </Avatar>
  );
}

import { supabase, ssoProvider } from '@/lib/supabase';
import { getAppRedirectUrl } from '@/lib/appUrl';

// Kick off the SSO provider redirect. `redirectPath` is the in-app path
// (router space, no base path) the user should land on after the provider
// round-trip. signInWithOAuth reports provider/config failures via the
// returned error rather than throwing — surface it so callers can react.
export async function signInWithSsoProvider(redirectPath: string = '/') {
  if (!ssoProvider) return;

  const { error } = await supabase.auth.signInWithOAuth({
    provider: ssoProvider,
    options: {
      redirectTo: getAppRedirectUrl(redirectPath),
    },
  });
  if (error) {
    throw error;
  }
}

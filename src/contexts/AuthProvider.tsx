import { useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase, ssoClaims } from '@/lib/supabase';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import posthog from 'posthog-js';
import { AuthContext, type BillingStatus, getLevel } from './AuthContext';
import { getAppRedirectUrl } from '@/lib/appUrl';

const LOCAL_BILLING_STATUS: BillingStatus = {
  user: { hasTrialed: true },
  subscription: null,
  tokens: {
    free: 300,
    subscription: 0,
    purchased: 0,
    total: 300,
  },
};

const AUTH_REFRESH_TIMEOUT_MS = 10_000;
const USER_DATA_TIMEOUT_MS = 8_000;
const USER_DATA_STALE_TIME_MS = 60_000;

/**
 * A browser extension, privacy filter, or stalled network request must never
 * leave the entire application behind its authentication spinner forever.
 */
async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Timed out while initializing Supabase auth')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function requestWithin<T>(
  request: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeoutId = setTimeout(abort, timeoutMs);

  parentSignal?.addEventListener('abort', abort, { once: true });

  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener('abort', abort);
  }
}

const ensurePermission = async () => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(
    typeof window === 'undefined'
      ? null
      : JSON.parse(localStorage.getItem('session') ?? 'null'),
  );
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();
  const posthogSent = useRef(false);
  const queryClient = useQueryClient();

  // Initialize auth state and set up session listener
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        const {
          data: { session },
        } = await resolveWithin(
          supabase.auth.refreshSession(),
          AUTH_REFRESH_TIMEOUT_MS,
        );
        setSession(session);
        localStorage.setItem('session', JSON.stringify(session));
        setUser(session?.user ?? null);
      } catch (error) {
        // Keep the signed-out UI usable when the Supabase Auth request is
        // blocked or stalls. A later auth-state event will still update it.
        console.warn(
          'Supabase auth initialization failed; continuing signed out.',
          error,
        );
        setSession(null);
        setUser(null);
        localStorage.removeItem('session');
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      localStorage.setItem('session', JSON.stringify(session));
      setUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') {
        navigate({ to: '/update-password' });
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  // Billing is not exposed in the current UI. Keep a local permissive status
  // so credits-dependent controls continue to work without starting a billing
  // session/request on every page load. Restore the query when billing returns.
  const billing = user ? LOCAL_BILLING_STATUS : null;
  const isBillingLoading = false;

  // Fetch user's profile data directly (avoiding circular dependency)
  const { data: profile, isLoading: isProfileLoading } = useQuery({
    queryKey: ['profile', user?.id],
    staleTime: USER_DATA_STALE_TIME_MS,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const { data, error } = await requestWithin(
        (requestSignal) =>
          supabase
            .from('profiles')
            .select('full_name, notifications_enabled')
            .eq('user_id', user?.id || '')
            .abortSignal(requestSignal)
            .single(),
        USER_DATA_TIMEOUT_MS,
        signal,
      );

      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  // Initialize notifications preference once on first render after profile loads
  useEffect(() => {
    if (profile?.notifications_enabled) void ensurePermission();
  }, [profile?.notifications_enabled]);

  // Set up real-time subscription for meshes table to update meshData immediately and notify the user
  useEffect(() => {
    if (!user) {
      return;
    }

    // Supabase realtime
    const channel = supabase
      .channel(`mesh-updates-${user.id}`)
      .on(
        'broadcast',
        {
          event: 'mesh-updated',
        },
        async ({ payload }) => {
          if (payload.kind === 'mesh') {
            queryClient.invalidateQueries({
              queryKey: ['meshData', payload.id],
            });
            queryClient.invalidateQueries({ queryKey: ['mesh', payload.id] });
            if (
              payload.status === 'success' &&
              profile?.notifications_enabled &&
              !window.location.pathname.includes(
                `/editor/${payload.conversation_id}`,
              )
            ) {
              if (await ensurePermission()) {
                const notification = new Notification('3D model is ready', {
                  body: 'Your generated 3D model has finished. Click to open.',
                  icon: `${import.meta.env.BASE_URL}iris-logo-180.png`,
                });
                notification.onclick = () => {
                  window.focus();
                  navigate({
                    to: '/editor/$id',
                    params: { id: payload.conversation_id },
                  });
                  notification.close();
                };
              }
            }
          }

          if (payload.kind === 'preview') {
            queryClient.invalidateQueries({
              queryKey: ['preview', payload.id],
            });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient, navigate, profile?.notifications_enabled]);

  // Track user in PostHog once we have all their data
  useEffect(() => {
    if (
      user &&
      !posthogSent.current &&
      !isBillingLoading &&
      !isProfileLoading
    ) {
      posthog.identify(user.id, {
        email: user.email,
        full_name: ssoClaims(user)?.name || profile?.full_name,
        subscription: getLevel(billing),
        has_trialed: billing?.user.hasTrialed ?? false,
      });
      posthogSent.current = true;
    }
  }, [user, isBillingLoading, billing, profile, isProfileLoading]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
  };

  const signUp = async (email: string, password: string, name: string) => {
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: name },
        emailRedirectTo: getAppRedirectUrl('/'),
      },
    });
    if (signUpError) throw signUpError;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const signInWithMagicLink = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: getAppRedirectUrl('/'),
      },
    });
    if (error) throw error;
  };

  const verifyOtp = async (email: string, token: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });
    if (error) throw error;
  };

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: getAppRedirectUrl('/update-password'),
    });
    if (error) throw error;
  };

  const updatePassword = async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user,
        billing,
        // Only authentication gates the app shell. Billing and profile load in
        // parallel and must never hold the whole workspace behind a spinner.
        isLoading,
        signIn,
        signUp,
        signInWithMagicLink,
        verifyOtp,
        signOut,
        resetPassword,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

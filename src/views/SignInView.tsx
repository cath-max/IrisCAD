import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { GoogleIcon } from '@/components/icons/CompanyIcons';
import { IrisLogo } from '@/components/iris/IrisLogo';
import { IrisWordmark } from '@/components/iris/IrisWordmark';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { supabase, ssoProvider } from '@/lib/supabase';
import { validateRedirectUrl } from '@/lib/utils';
import { getAppRedirectUrl } from '@/lib/appUrl';

// Local development can authenticate without production Google OAuth credentials.
const showLocalEmailAuth =
  import.meta.env.DEV &&
  !ssoProvider &&
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(
    import.meta.env.VITE_SUPABASE_URL || '',
  );

export function SignInView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, user, signIn, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { toast } = useToast();
  const searchParams = new URLSearchParams(location.searchStr);
  const redirectPath = validateRedirectUrl(searchParams.get('redirect'));

  useEffect(() => {
    if (!authLoading && session && user) {
      void navigate({ to: redirectPath, replace: true });
    }
  }, [authLoading, navigate, session, user, redirectPath]);

  const { mutate: signInWithEmail, isPending: emailPending } = useMutation({
    mutationFn: () => signIn(email.trim(), password),
    onError: (error) =>
      toast({
        title: 'Unable to sign in',
        description:
          error instanceof Error
            ? error.message
            : 'Please check your email and password.',
        variant: 'destructive',
      }),
  });

  const { mutate: signInWithGoogle, isPending } = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: getAppRedirectUrl(redirectPath),
        },
      });

      if (error) throw error;
    },
    onError: (error) => {
      toast({
        title: 'Unable to sign in',
        description:
          error instanceof Error ? error.message : 'Something went wrong',
        variant: 'destructive',
      });
    },
  });

  return (
    <main className="iris-signin-page">
      <button
        type="button"
        className="iris-signin-back"
        aria-label="Back to IrisCAD"
        onClick={() => void navigate({ to: '/' })}
      >
        <ArrowLeft aria-hidden="true" />
      </button>

      <section className="iris-signin-card" aria-label="Sign in to IrisCAD">
        <div className="iris-signin-brand">
          <IrisLogo className="iris-signin-logo" alt="" />
          <IrisWordmark className="iris-signin-wordmark" />
        </div>

        <button
          type="button"
          className="iris-signin-google"
          disabled={isPending || emailPending}
          onClick={() => signInWithGoogle()}
        >
          <GoogleIcon aria-hidden="true" />
          <span>{isPending ? 'Connecting…' : 'Continue with Google'}</span>
        </button>
        {showLocalEmailAuth && (
          <form
            className="mt-6 flex w-full flex-col gap-3 text-left text-sm text-slate-800"
            onSubmit={(event) => {
              event.preventDefault();
              if (!emailPending && !isPending) signInWithEmail();
            }}
          >
            <p className="text-center text-slate-500">Local email sign in</p>
            <label className="flex flex-col gap-1">
              Email
              <input
                className="rounded-lg border border-slate-300 bg-white px-3 py-2"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={emailPending || isPending}
              />
            </label>
            <label className="flex flex-col gap-1">
              Password
              <input
                className="rounded-lg border border-slate-300 bg-white px-3 py-2"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={emailPending || isPending}
              />
            </label>
            <button
              className="rounded-lg bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
              type="submit"
              disabled={emailPending || isPending}
            >
              {emailPending ? 'Signing in…' : 'Sign in with email'}
            </button>
            <div className="flex justify-between gap-3">
              <Link to="/signup-email" className="underline">
                Create local account
              </Link>
              <Link to="/reset-password" className="underline">
                Forgot password?
              </Link>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

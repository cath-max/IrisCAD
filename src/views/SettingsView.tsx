import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { DeleteAccountDialog } from '@/components/auth/DeleteAccountDialog';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import * as Sentry from '@sentry/react';
import { useProfile, useUpdateProfile } from '@/services/profileService';
import { AvatarUpdateDialog } from '@/components/auth/AvatarUpdateDialog';
import { accountUrl, ssoManaged } from '@/lib/supabase';
import { UserAvatar } from '@/components/chat/UserAvatar';

export default function SettingsView() {
  const navigate = useNavigate();
  const { user, resetPassword } = useAuth();
  const { data: profile } = useProfile();
  const { mutate: updateProfile, isPending: isUpdateLoading } =
    useUpdateProfile();
  const { toast } = useToast();
  const [newName, setNewName] = useState(profile?.full_name || '');
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const settingsPageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
    }
  }, [editingName]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      settingsPageRef.current?.scrollTo({ top: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setNewName(profile?.full_name || '');
  }, [profile?.full_name]);

  const handleUpdateName = () => {
    updateProfile(
      { full_name: newName },
      {
        onSuccess: () => {
          setEditingName(false);
          setNewName(profile?.full_name || '');
          toast({
            title: 'Success',
            description: 'Your name has been updated',
          });
        },
        onError: (e) => {
          Sentry.captureException(e);
          toast({
            title: 'Error',
            description: 'Failed to update name',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleUpdateNotifications = async (notificationsEnabled: boolean) => {
    updateProfile(
      {
        notifications_enabled: notificationsEnabled,
      },
      {
        onSuccess: () => {
          toast({
            title: 'Success',
            description: 'Your notifications have been updated',
          });
        },
        onError: (e) => {
          Sentry.captureException(e);
          toast({
            title: 'Error',
            description: 'Failed to update notifications',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const [maxRoundsDraft, setMaxRoundsDraft] = useState(
    profile?.agent_max_build_rounds ?? 20,
  );

  useEffect(() => {
    setMaxRoundsDraft(profile?.agent_max_build_rounds ?? 20);
  }, [profile?.agent_max_build_rounds]);

  const handleSaveMaxBuildRounds = () => {
    const clamped = Math.min(40, Math.max(1, Math.round(maxRoundsDraft) || 20));
    setMaxRoundsDraft(clamped);
    if (clamped === profile?.agent_max_build_rounds) return;
    updateProfile(
      { agent_max_build_rounds: clamped },
      {
        onSuccess: () => {
          toast({
            title: 'Success',
            description: 'Max build iterations updated',
          });
        },
        onError: (e) => {
          Sentry.captureException(e);
          toast({
            title: 'Error',
            description: 'Failed to update max build iterations',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleUpdateRequireBuildApproval = (enabled: boolean) => {
    updateProfile(
      { agent_require_build_approval: enabled },
      {
        onSuccess: () => {
          toast({
            title: 'Success',
            description: 'Revision approval setting updated',
          });
        },
        onError: (e) => {
          Sentry.captureException(e);
          toast({
            title: 'Error',
            description: 'Failed to update revision approval setting',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleUpdateShowSevenView = (enabled: boolean) => {
    updateProfile(
      { agent_show_seven_view: enabled },
      {
        onSuccess: () => {
          toast({
            title: 'Success',
            description: 'Seven-view preview setting updated',
          });
        },
        onError: (e) => {
          Sentry.captureException(e);
          toast({
            title: 'Error',
            description: 'Failed to update seven-view setting',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const { mutate: handleResetPassword, isPending: isResetLoading } =
    useMutation({
      mutationFn: async () => {
        if (!user?.email) throw new Error('User email not found');
        await resetPassword(user?.email);
      },
      onSuccess: () => {
        toast({
          title: 'Success',
          description:
            'Password reset instructions have been sent to your email',
        });
      },
      onError: () => {
        toast({
          title: 'Error',
          description: 'Failed to reset password',
          variant: 'destructive',
        });
      },
    });

  // When SSO owns the identity and an external account page is configured,
  // profile / email / password / delete are managed there (the
  // accounts.google.com model) rather than edited in-app. Self-host (no SSO
  // or no account URL) keeps the native controls. `ssoManaged` is imported from
  // @/lib/supabase so every SSO gate shares one definition.

  return (
    <div
      ref={settingsPageRef}
      className="iris-settings-page flex min-h-full w-full items-start justify-center bg-adam-background-1 px-6 py-10"
    >
      <div className="w-full max-w-xl">
        <header className="mb-8">
          <button
            type="button"
            className="iris-settings-back"
            aria-label="Back to previous page"
            onClick={() => {
              if (window.history.length > 1) {
                window.history.back();
              } else {
                void navigate({ to: '/' });
              }
            }}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <h1 className="text-2xl font-medium tracking-tight text-adam-neutral-50">
            Settings
          </h1>
        </header>

        <div className="flex flex-col gap-4">
          {/* Account */}
          <section className="rounded-xl border border-adam-neutral-800 bg-adam-background-2 p-6">
            <h2 className="mb-5 text-sm font-medium text-adam-neutral-50">
              Account
            </h2>

            {ssoManaged ? (
              <div className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <UserAvatar className="h-10 w-10" />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-adam-neutral-50">
                      {profile?.full_name || user?.email}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-adam-neutral-200">
                      {user?.email}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-adam-neutral-800 pt-5">
                  <div className="min-w-0">
                    <div className="text-sm text-adam-neutral-50">
                      Manage account
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-adam-neutral-200">
                      Update your name, email, password, and account details in
                      your account.
                    </div>
                  </div>
                  <a
                    href={accountUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-shrink-0"
                  >
                    <Button variant="dark" className="rounded-full font-light">
                      Manage account
                    </Button>
                  </a>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-4 pb-5">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <AvatarUpdateDialog />
                    {editingName ? (
                      <Input
                        ref={nameInputRef}
                        value={newName}
                        className="h-9 w-full max-w-xs"
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleUpdateName();
                          }
                        }}
                      />
                    ) : (
                      <div className="min-w-0 truncate text-sm text-adam-neutral-50">
                        {profile?.full_name || user?.email}
                      </div>
                    )}
                  </div>
                  {editingName ? (
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <Button
                        onClick={() => handleUpdateName()}
                        variant="light"
                        disabled={isUpdateLoading}
                        className="rounded-full font-light"
                      >
                        {isUpdateLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          'Save'
                        )}
                      </Button>
                      <Button
                        onClick={() => {
                          setEditingName(false);
                          setNewName(profile?.full_name || '');
                        }}
                        variant="dark"
                        className="rounded-full font-light"
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      onClick={() => setEditingName(true)}
                      variant="dark"
                      className="flex-shrink-0 rounded-full font-light"
                    >
                      Edit
                    </Button>
                  )}
                </div>

                <div className="py-5">
                  <div className="text-sm text-adam-neutral-50">Email</div>
                  <div className="mt-0.5 truncate text-xs text-adam-neutral-200">
                    {user?.email}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 pt-5">
                  <div className="min-w-0">
                    <div className="text-sm text-adam-neutral-50">Password</div>
                    <div className="mt-0.5 text-xs text-adam-neutral-200">
                      Send a reset link to your email
                    </div>
                  </div>
                  <Button
                    onClick={() => handleResetPassword()}
                    disabled={isResetLoading}
                    variant="dark"
                    className="flex-shrink-0 rounded-full font-light"
                  >
                    {isResetLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Reset Password'
                    )}
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* Notifications */}
          <section className="rounded-xl border border-adam-neutral-800 bg-adam-background-2 p-6">
            <h2 className="mb-5 text-sm font-medium text-adam-neutral-50">
              Notifications
            </h2>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-adam-neutral-50">Responses</div>
                <div className="mt-0.5 text-xs leading-relaxed text-adam-neutral-200">
                  Get notified when Iris finishes a long-running request.
                </div>
              </div>
              <Switch
                className="mt-0.5"
                checked={profile?.notifications_enabled ?? false}
                onCheckedChange={handleUpdateNotifications}
              />
            </div>
          </section>

          {/* Agent */}
          <section className="rounded-xl border border-adam-neutral-800 bg-adam-background-2 p-6">
            <h2 className="mb-5 text-sm font-medium text-adam-neutral-50">
              Agent
            </h2>

            <div className="flex flex-col gap-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-adam-neutral-50">
                    Max build iterations
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-adam-neutral-200">
                    Soft limit for automatic CAD rebuilds after each request
                    (1–40). Failed builds may continue up to twice this value.
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={40}
                    value={maxRoundsDraft}
                    onChange={(e) =>
                      setMaxRoundsDraft(Number(e.target.value) || 1)
                    }
                    onBlur={handleSaveMaxBuildRounds}
                    className="h-9 w-20 rounded-full border-adam-neutral-700 bg-adam-background-1 text-center text-sm"
                  />
                  <Button
                    onClick={handleSaveMaxBuildRounds}
                    disabled={
                      isUpdateLoading ||
                      maxRoundsDraft === (profile?.agent_max_build_rounds ?? 20)
                    }
                    variant="dark"
                    className="rounded-full font-light"
                  >
                    Save
                  </Button>
                </div>
              </div>

              <div className="flex items-start justify-between gap-4 border-t border-adam-neutral-800 pt-5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-adam-neutral-50">
                    Require approval before shape correction edits
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-adam-neutral-200">
                    After a build runs successfully, the model may still find
                    shape issues in the seven-view review and prepare a
                    corrected script. Pause for Continue before that correction
                    build runs. You can optionally add feedback. The first build
                    and failed-run retries still execute automatically.
                  </div>
                </div>
                <Switch
                  className="mt-0.5"
                  checked={profile?.agent_require_build_approval ?? false}
                  onCheckedChange={handleUpdateRequireBuildApproval}
                />
              </div>

              <div className="flex items-start justify-between gap-4 border-t border-adam-neutral-800 pt-5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-adam-neutral-50">
                    Show seven-view previews in chat
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-adam-neutral-200">
                    Show inspection-sheet thumbnails in the chat bubble. The
                    model still receives seven-view images either way.
                  </div>
                </div>
                <Switch
                  className="mt-0.5"
                  checked={profile?.agent_show_seven_view ?? false}
                  onCheckedChange={handleUpdateShowSevenView}
                />
              </div>
            </div>
          </section>

          {/* Data & Privacy — when SSO owns the identity, account deletion is
              handled by the identity provider ("Manage account" above), so the
              in-app delete is hidden to avoid a partial, one-sided delete. */}
          {!ssoManaged && (
            <section className="rounded-xl border border-adam-neutral-800 bg-adam-background-2 p-6">
              <h2 className="mb-5 text-sm font-medium text-adam-neutral-50">
                Data and privacy
              </h2>

              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-adam-neutral-50">
                    Delete account
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-adam-neutral-200">
                    Permanently delete your account and all associated data.
                  </div>
                </div>
                <DeleteAccountDialog>
                  <Button
                    className="flex-shrink-0 rounded-full font-light"
                    variant="destructive"
                  >
                    Delete
                  </Button>
                </DeleteAccountDialog>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

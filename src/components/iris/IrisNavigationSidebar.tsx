import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import {
  EllipsisVertical,
  Gauge,
  LayoutGrid,
  LogIn,
  LogOut,
  Menu,
  Plus,
  Settings,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ssoProvider } from '@/lib/supabase';
import { useProfile } from '@/services/profileService';
import { UserAvatar } from '@/components/chat/UserAvatar';
import { GitHubIcon } from '@/components/icons/CompanyIcons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { IrisLogo } from './IrisLogo';
import { IrisSidebar } from './IrisSidebar';
import { IrisWordmark } from './IrisWordmark';

type IrisSidebarContentProps = {
  onNavigate?: () => void;
};

function IrisSidebarContent({ onNavigate }: IrisSidebarContentProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, billing, signOut } = useAuth();
  const { data: profile } = useProfile();
  const accountMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [accountMenuWidth, setAccountMenuWidth] = useState(190);

  const syncAccountMenuWidth = useCallback(() => {
    const sidebar = accountMenuTriggerRef.current?.closest('.iris-sidebar');
    const newCreation =
      sidebar?.querySelector<HTMLElement>('.iris-new-creation');
    if (newCreation) setAccountMenuWidth(newCreation.offsetWidth);
  }, []);

  useEffect(() => {
    if (!isAccountMenuOpen) return;
    syncAccountMenuWidth();
    const sidebar = accountMenuTriggerRef.current?.closest('.iris-sidebar');
    if (!sidebar) return;
    const observer = new ResizeObserver(syncAccountMenuWidth);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [isAccountMenuOpen, syncAccountMenuWidth]);

  const navigateTo = async (to: '/' | '/history' | '/settings') => {
    onNavigate?.();
    await navigate({ to });
  };

  const handleSignOut = async () => {
    if (ssoProvider) {
      await navigate({ to: '/' });
      await signOut();
      return;
    }
    await signOut();
    await navigate({ to: '/signin' });
  };

  const displayName =
    profile?.full_name || user?.email?.split('@')[0] || 'User';

  return (
    <IrisSidebar
      primaryActionSlot={
        <div className="iris-sidebar-brand-block">
          <button
            type="button"
            className="iris-sidebar-logo-button"
            aria-label="Iris home"
            onClick={() => void navigateTo('/')}
          >
            <IrisLogo className="iris-sidebar-logo" />
            <IrisWordmark compact />
          </button>
          <button
            type="button"
            className="iris-new-creation"
            disabled={!user}
            onClick={() => void navigateTo('/')}
          >
            <Plus aria-hidden="true" />
            <span>New Creation</span>
          </button>
        </div>
      }
      historySlot={
        <nav aria-label="History">
          <button
            type="button"
            className="iris-creations-link"
            disabled={!user}
            data-active={location.pathname === '/history'}
            onClick={() => void navigateTo('/history')}
          >
            <LayoutGrid aria-hidden="true" />
            <span>History</span>
          </button>
        </nav>
      }
      accountSlot={
        user ? (
          <div className="iris-sidebar-footer">
            <a
              className="iris-sidebar-github-link"
              href="https://github.com/cath-max/iriscad"
              target="_blank"
              rel="noreferrer"
              aria-label="View IrisCAD source on GitHub"
              onClick={onNavigate}
            >
              <GitHubIcon aria-hidden="true" />
              <span>GitHub</span>
            </a>
            <div className="iris-sidebar-account-card">
              <div className="iris-account-row">
                <UserAvatar className="iris-account-avatar" />
                <div className="iris-account-copy">
                  <strong>{displayName}</strong>
                  <span>{user.email}</span>
                </div>
                <DropdownMenu
                  open={isAccountMenuOpen}
                  onOpenChange={setIsAccountMenuOpen}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      ref={accountMenuTriggerRef}
                      type="button"
                      className="iris-account-menu-button"
                      aria-label="Account menu"
                    >
                      <EllipsisVertical aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    side="top"
                    sideOffset={8}
                    style={{ width: accountMenuWidth }}
                    className="iris-account-menu border-[#dedee3] bg-[#fbfbfd] text-[#1d1d1f]"
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        className="focus:bg-[#ececef] focus:text-[#1d1d1f]"
                        onSelect={() => void navigateTo('/settings')}
                      >
                        <Settings className="mr-2 h-4 w-4" />
                        Settings
                      </DropdownMenuItem>
                      <DropdownMenuItem className="iris-account-menu__credits focus:bg-[#ececef] focus:text-[#1d1d1f]">
                        <Gauge className="mr-2 h-4 w-4" />
                        <span>Credits</span>
                        <strong>
                          {(billing?.tokens.total ?? 0).toLocaleString()}
                        </strong>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuItem
                      className="focus:bg-[#ececef] focus:text-[#1d1d1f]"
                      onSelect={() => void handleSignOut()}
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        ) : (
          <div className="iris-sidebar-footer">
            <button
              type="button"
              className="iris-sidebar-sign-in"
              onClick={() => {
                onNavigate?.();
                void navigate({ to: '/signin' });
              }}
            >
              <LogIn aria-hidden="true" />
              <span>Sign in</span>
            </button>
          </div>
        )
      }
    />
  );
}

export function IrisNavigationSidebar() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!isMobile) return <IrisSidebarContent />;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="iris-mobile-navigation-trigger"
          aria-label="Open navigation"
        >
          <Menu aria-hidden="true" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="iris-navigation-sheet w-[min(88vw,320px)] border-r-0 p-0 [&>button]:text-[#6e6e73]"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Iris navigation</SheetTitle>
          <SheetDescription>
            Create and open projects or manage your account.
          </SheetDescription>
        </SheetHeader>
        <IrisSidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

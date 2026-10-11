import { Outlet, useLocation } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useAgentActivity } from '@/contexts/AgentActivityContext';
import { HistoryView } from '@/views/HistoryView';
import { IrisCadShell } from './IrisCadShell';
import { IrisNavigationSidebar } from './IrisNavigationSidebar';
import { isIrisCreationRoute, isIrisWorkspaceRoute } from './irisRouteMode';

export function IrisLayout() {
  const { user, isLoading } = useAuth();
  const { isAgentActive } = useAgentActivity();
  const location = useLocation();
  const isCreationRoute = isIrisCreationRoute(location.pathname);
  const isWorkspaceRoute = isIrisWorkspaceRoute(location.pathname);
  const isSettingsRoute = location.pathname === '/settings';
  const isHistoryRoute = location.pathname === '/history';
  const routeContent = isHistoryRoute ? <HistoryView /> : <Outlet />;

  if (isLoading) {
    return (
      <div className="iris-layout-loading" role="status" aria-label="Loading">
        <Loader2 aria-hidden="true" />
      </div>
    );
  }

  // Authentication routes keep their existing flows. The signed-out root,
  // however, deliberately reuses the same Iris creation shell as signed-in
  // users and lets PromptView expose its read-only state.
  if (!user && location.pathname !== '/') return <Outlet />;

  // Editor and Share own their Iris shell so their existing ChatSession,
  // ThreeScene, and Model controls can be mounted as stable slots instead of
  // nesting a second workspace inside this route-level shell.
  if (isWorkspaceRoute) return <Outlet />;

  return (
    <IrisCadShell
      sidebarSlot={<IrisNavigationSidebar />}
      agentActive={isAgentActive}
      hideInspector={isCreationRoute || isSettingsRoute || isHistoryRoute}
      allowSidebarResize={isHistoryRoute}
      homeSurface={isCreationRoute}
      agentSlot={<div className="iris-empty-slot" aria-label="Agent slot" />}
      previewSlot={routeContent}
      modelSlot={<div className="iris-empty-slot" aria-label="Model slot" />}
    />
  );
}

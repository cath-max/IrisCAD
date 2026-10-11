import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ChevronLeft,
  MessageCircle,
  PanelLeft,
  SlidersHorizontal,
} from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CadWorkspace } from './CadWorkspace';
import { IrisSidebar, type IrisSidebarProps } from './IrisSidebar';
import { MobileWorkspaceSheet } from './MobileWorkspaceSheet';
import { WorkspaceInspector, type InspectorTab } from './WorkspaceInspector';
import './iris-shell.css';

export type IrisCadShellProps = IrisSidebarProps & {
  agentSlot: ReactNode;
  previewSlot: ReactNode;
  modelSlot: ReactNode;
  sidebarSlot?: ReactNode;
  agentActive?: boolean;
  hideInspector?: boolean;
  allowSidebarResize?: boolean;
  homeSurface?: boolean;
  previewDepth?: boolean;
  previewTitleSlot?: ReactNode;
  previewActionSlot?: ReactNode;
  previewToolbarSlot?: ReactNode;
  defaultInspectorTab?: InspectorTab;
};

export function IrisCadShell({
  agentSlot,
  previewSlot,
  modelSlot,
  sidebarSlot,
  agentActive = false,
  hideInspector = false,
  allowSidebarResize = false,
  homeSurface = false,
  previewDepth = false,
  previewTitleSlot,
  previewActionSlot,
  previewToolbarSlot,
  primaryActionSlot,
  historySlot,
  accountSlot,
  defaultInspectorTab = 'agent',
}: IrisCadShellProps) {
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<InspectorTab>(defaultInspectorTab);
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('irisSidebarWidth'));
    return Number.isFinite(saved) && saved >= 164 && saved <= 300 ? saved : 196;
  });
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem('irisInspectorWidth'));
    return Number.isFinite(saved) && saved >= 320 && saved <= 640 ? saved : 420;
  });
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    () => localStorage.getItem('irisSidebarOpen') !== 'false',
  );
  const [isInspectorOpen, setIsInspectorOpen] = useState(
    () => localStorage.getItem('irisInspectorOpen') !== 'false',
  );

  useEffect(() => {
    localStorage.setItem('irisSidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem('irisInspectorWidth', String(inspectorWidth));
  }, [inspectorWidth]);

  useEffect(() => {
    localStorage.setItem('irisSidebarOpen', String(isSidebarOpen));
  }, [isSidebarOpen]);

  useEffect(() => {
    localStorage.setItem('irisInspectorOpen', String(isInspectorOpen));
  }, [isInspectorOpen]);

  const openMobileInspector = useCallback((tab: InspectorTab) => {
    setActiveTab(tab);
    setIsMobileSheetOpen(true);
  }, []);

  const beginResize = useCallback(
    (edge: 'sidebar' | 'inspector') =>
      (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (isMobile || (hideInspector && !homeSurface && !allowSidebarResize))
          return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = edge === 'sidebar' ? sidebarWidth : inspectorWidth;
        event.currentTarget.setPointerCapture(event.pointerId);
        const handleMove = (moveEvent: PointerEvent) => {
          const delta = moveEvent.clientX - startX;
          if (edge === 'sidebar') {
            setSidebarWidth(Math.min(300, Math.max(164, startWidth + delta)));
          } else {
            setInspectorWidth(Math.min(640, Math.max(320, startWidth - delta)));
          }
        };
        const handleEnd = () => {
          window.removeEventListener('pointermove', handleMove);
          window.removeEventListener('pointerup', handleEnd);
          window.removeEventListener('pointercancel', handleEnd);
        };
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleEnd);
        window.addEventListener('pointercancel', handleEnd);
      },
    [
      allowSidebarResize,
      hideInspector,
      homeSurface,
      inspectorWidth,
      isMobile,
      sidebarWidth,
    ],
  );

  const inspector = (
    <WorkspaceInspector
      agentSlot={agentSlot}
      modelSlot={modelSlot}
      activeTab={activeTab}
      onActiveTabChange={setActiveTab}
      agentActive={agentActive}
      closeControlSlot={
        !isMobile ? (
          <button
            type="button"
            className="iris-inspector-close"
            aria-label="Close inspector panel"
            onClick={() => setIsInspectorOpen(false)}
          >
            <PanelLeft aria-hidden="true" />
          </button>
        ) : null
      }
    />
  );

  const mobileControls =
    isMobile && !hideInspector ? (
      <nav className="iris-mobile-controls" aria-label="Workspace panels">
        <button type="button" onClick={() => openMobileInspector('agent')}>
          <MessageCircle aria-hidden="true" />
          <span>Agent</span>
        </button>
        <button type="button" onClick={() => openMobileInspector('model')}>
          <SlidersHorizontal aria-hidden="true" />
          <span>Model</span>
        </button>
      </nav>
    ) : null;

  return (
    <div className="iris-shell-stage" data-home={homeSurface}>
      <section
        className="iris-cad-shell"
        data-creation={hideInspector}
        data-home={homeSurface}
        data-preview-depth={previewDepth}
        data-sidebar-open={isSidebarOpen}
        data-sidebar-resizable={allowSidebarResize}
        data-inspector-open={hideInspector || isInspectorOpen}
        data-resizable={
          !isMobile && (!hideInspector || homeSurface || allowSidebarResize)
        }
        aria-label="Iris CAD workspace"
        style={
          {
            '--iris-sidebar-width': `${sidebarWidth}px`,
            '--iris-inspector-width': `${inspectorWidth}px`,
          } as CSSProperties
        }
      >
        {(isMobile || isSidebarOpen) &&
          (sidebarSlot ??
            (!isMobile && (
              <IrisSidebar
                primaryActionSlot={primaryActionSlot}
                historySlot={historySlot}
                accountSlot={accountSlot}
              />
            )))}

        {!isMobile &&
        (!hideInspector || homeSurface || allowSidebarResize) &&
        isSidebarOpen ? (
          <button
            type="button"
            className="iris-resize-handle"
            aria-label="Resize navigation panel"
            onPointerDown={beginResize('sidebar')}
          />
        ) : null}

        <CadWorkspace
          previewSlot={previewSlot}
          titleSlot={previewTitleSlot}
          actionSlot={previewActionSlot}
          toolbarSlot={previewToolbarSlot}
          mobileControlsSlot={mobileControls}
          topLeftControlSlot={
            !isMobile ? (
              <button
                type="button"
                className="iris-home-sidebar-toggle"
                aria-label={
                  isSidebarOpen
                    ? 'Close navigation panel'
                    : 'Open navigation panel'
                }
                aria-expanded={isSidebarOpen}
                onClick={() => setIsSidebarOpen((isOpen) => !isOpen)}
              >
                <PanelLeft aria-hidden="true" />
              </button>
            ) : null
          }
        />

        {!isMobile && !hideInspector && isInspectorOpen ? (
          <button
            type="button"
            className="iris-resize-handle"
            aria-label="Resize inspector panel"
            onPointerDown={beginResize('inspector')}
          />
        ) : null}

        {!hideInspector && isMobile ? (
          <MobileWorkspaceSheet
            open={isMobileSheetOpen}
            title={`${activeTab === 'agent' ? 'Agent' : 'Model'} inspector`}
            onClose={() => setIsMobileSheetOpen(false)}
          >
            {inspector}
          </MobileWorkspaceSheet>
        ) : !hideInspector && isInspectorOpen ? (
          inspector
        ) : null}

        {!isMobile && !hideInspector && !isInspectorOpen ? (
          <button
            type="button"
            className="iris-inspector-restore"
            aria-label="Open inspector panel"
            onClick={() => setIsInspectorOpen(true)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : null}
      </section>
    </div>
  );
}

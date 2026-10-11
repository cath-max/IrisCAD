import {
  useCallback,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Box } from 'lucide-react';
import { IrisLogo } from './IrisLogo';

export type InspectorTab = 'agent' | 'model';

type InspectorTabButtonProps = {
  id: string;
  panelId: string;
  label: ReactNode;
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
};

function InspectorTabButton({
  id,
  panelId,
  label,
  selected,
  onSelect,
  onKeyDown,
  buttonRef,
}: InspectorTabButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="iris-inspector-tab"
      role="tab"
      id={id}
      aria-controls={panelId}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {label}
    </button>
  );
}

export function AgentTab({
  active = false,
  ...props
}: Omit<InspectorTabButtonProps, 'label'> & { active?: boolean }) {
  return (
    <InspectorTabButton
      {...props}
      label={
        <span className="iris-agent-tab-label">
          <IrisLogo active={active} className="iris-agent-tab-logo" alt="" />
          <span>Agent</span>
        </span>
      }
    />
  );
}

export function ModelTab(props: Omit<InspectorTabButtonProps, 'label'>) {
  return (
    <InspectorTabButton
      {...props}
      label={
        <span className="iris-model-tab-label">
          <Box aria-hidden="true" />
          <span>Model</span>
        </span>
      }
    />
  );
}

export type WorkspaceInspectorProps = {
  agentSlot: ReactNode;
  modelSlot: ReactNode;
  activeTab: InspectorTab;
  onActiveTabChange: (tab: InspectorTab) => void;
  agentActive?: boolean;
  className?: string;
  closeControlSlot?: ReactNode;
};

export function WorkspaceInspector({
  agentSlot,
  modelSlot,
  activeTab,
  onActiveTabChange,
  agentActive = false,
  className = '',
  closeControlSlot,
}: WorkspaceInspectorProps) {
  const instanceId = useId().replace(/:/g, '');
  const agentTabId = `iris-agent-tab-${instanceId}`;
  const modelTabId = `iris-model-tab-${instanceId}`;
  const agentPanelId = `iris-agent-panel-${instanceId}`;
  const modelPanelId = `iris-model-panel-${instanceId}`;
  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({
    agent: null,
    model: null,
  });

  const selectAndFocus = useCallback(
    (tab: InspectorTab) => {
      onActiveTabChange(tab);
      tabRefs.current[tab]?.focus();
    },
    [onActiveTabChange],
  );

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      let nextTab: InspectorTab | null = null;
      if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowRight' ||
        event.key === 'ArrowDown'
      ) {
        nextTab = activeTab === 'agent' ? 'model' : 'agent';
      } else if (event.key === 'Home') {
        nextTab = 'agent';
      } else if (event.key === 'End') {
        nextTab = 'model';
      }

      if (nextTab) {
        event.preventDefault();
        selectAndFocus(nextTab);
      }
    },
    [activeTab, selectAndFocus],
  );

  return (
    <aside
      className={`iris-inspector ${className}`.trim()}
      aria-label="Agent and model controls"
    >
      {closeControlSlot}
      <div
        className="iris-inspector-tabs"
        role="tablist"
        aria-label="Inspector mode"
        aria-orientation="horizontal"
      >
        <AgentTab
          active={agentActive}
          id={agentTabId}
          panelId={agentPanelId}
          selected={activeTab === 'agent'}
          onSelect={() => onActiveTabChange('agent')}
          onKeyDown={handleTabKeyDown}
          buttonRef={(node) => {
            tabRefs.current.agent = node;
          }}
        />
        <ModelTab
          id={modelTabId}
          panelId={modelPanelId}
          selected={activeTab === 'model'}
          onSelect={() => onActiveTabChange('model')}
          onKeyDown={handleTabKeyDown}
          buttonRef={(node) => {
            tabRefs.current.model = node;
          }}
        />
      </div>

      <section
        className="iris-inspector-panel iris-inspector-panel--agent"
        id={agentPanelId}
        role="tabpanel"
        aria-labelledby={agentTabId}
        aria-hidden={activeTab !== 'agent'}
        hidden={activeTab !== 'agent'}
        inert={activeTab !== 'agent'}
      >
        {agentSlot}
      </section>
      <section
        className="iris-inspector-panel"
        id={modelPanelId}
        role="tabpanel"
        aria-labelledby={modelTabId}
        aria-hidden={activeTab !== 'model'}
        hidden={activeTab !== 'model'}
        inert={activeTab !== 'model'}
      >
        {modelSlot}
      </section>
    </aside>
  );
}

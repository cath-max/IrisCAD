/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type AgentActivityContextValue = {
  isAgentActive: boolean;
  reportActivity: (sourceId: string, active: boolean) => void;
};

const AgentActivityContext = createContext<AgentActivityContextValue>({
  isAgentActive: false,
  reportActivity: () => undefined,
});

export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set());

  const reportActivity = useCallback((sourceId: string, active: boolean) => {
    setActiveSources((current) => {
      const alreadyActive = current.has(sourceId);
      if (alreadyActive === active) return current;
      const next = new Set(current);
      if (active) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ isAgentActive: activeSources.size > 0, reportActivity }),
    [activeSources, reportActivity],
  );

  return (
    <AgentActivityContext.Provider value={value}>
      {children}
    </AgentActivityContext.Provider>
  );
}

export function useAgentActivity() {
  return useContext(AgentActivityContext);
}

export function useReportAgentActivity(sourceId: string, active: boolean) {
  const { reportActivity } = useAgentActivity();

  useEffect(() => {
    reportActivity(sourceId, active);
    return () => reportActivity(sourceId, false);
  }, [active, reportActivity, sourceId]);
}

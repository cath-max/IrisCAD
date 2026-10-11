import { useEffect } from 'react';

import { warmupSimpleCadWorker } from '@/worker/simpleCadToolWorker';

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Warm Pyodide + OCP only after the initial page and high-priority assets have
 * loaded. On constrained connections, let the first real CAD operation start
 * initialization instead of spending bandwidth automatically.
 */
export function useWarmSimpleCadWorker(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    if (
      connection?.saveData ||
      connection?.effectiveType === 'slow-2g' ||
      connection?.effectiveType === '2g'
    ) {
      return;
    }

    const idleWindow = window as IdleWindow;
    let idleHandle: number | undefined;
    let fallbackHandle: ReturnType<typeof setTimeout> | undefined;

    const warmWhenIdle = () => {
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(
          () => void warmupSimpleCadWorker().catch(() => undefined),
          { timeout: 10_000 },
        );
      } else {
        fallbackHandle = setTimeout(
          () => void warmupSimpleCadWorker().catch(() => undefined),
          2_000,
        );
      }
    };

    if (document.readyState === 'complete') warmWhenIdle();
    else window.addEventListener('load', warmWhenIdle, { once: true });

    return () => {
      window.removeEventListener('load', warmWhenIdle);
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
      if (fallbackHandle !== undefined) clearTimeout(fallbackHandle);
    };
  }, [enabled]);
}

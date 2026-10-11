import { runOrbitCleanup } from '../../utils/orbitGifState.ts';

interface PreviewSession {
  frameloop: 'always' | 'demand' | 'never';
  setFrameloop: (mode: 'always' | 'demand' | 'never') => void;
  invalidate: () => void;
  controls?: { enabled: boolean } | null;
}

/** DEV bridge boundary: suspend useFrame subscribers for capture and encoding. */
export async function withPausedOrbitPreview<T>(
  state: PreviewSession,
  task: () => Promise<T>,
): Promise<T> {
  const previousMode = state.frameloop;
  const controls = state.controls;
  const previousEnabled = controls?.enabled;
  try {
    state.setFrameloop('never');
    if (controls) controls.enabled = false;
    return await task();
  } finally {
    runOrbitCleanup([
      () => {
        if (controls && previousEnabled !== undefined)
          controls.enabled = previousEnabled;
      },
      () => state.setFrameloop(previousMode),
      () => state.invalidate(),
    ]);
  }
}

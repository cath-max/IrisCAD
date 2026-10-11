import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type * as THREE from 'three';
import { useToast } from '@/hooks/use-toast';
import { downloadFile } from '@/utils/downloadUtils';
import type {
  OrbitControlsLike,
  OrbitGifProgress,
} from '@/utils/exportOrbitGif';
import { withPausedOrbitPreview } from './orbitGifPreviewSession';

export default function DevOrbitGifExporter({
  objectRef,
  filenameBase,
}: {
  objectRef: RefObject<THREE.Object3D | null>;
  filenameBase: string;
}) {
  const get = useThree((state) => state.get);
  const { toast } = useToast();
  const [customFilename, setCustomFilename] = useState<string | null>(null);
  const filename = customFilename ?? `${filenameBase}-orbit.gif`;
  const [busy, setBusy] = useState(false);
  const [fillPercent, setFillPercent] = useState(92);
  const [includePng, setIncludePng] = useState(false);
  const [comparisonPng, setComparisonPng] = useState<{
    content: Blob;
    filename: string;
  } | null>(null);
  const [progress, setProgress] = useState<OrbitGifProgress | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);

  const startExport = async (format: 'gif' | 'png' = 'gif') => {
    if (active.current) return;
    const object = objectRef.current;
    if (!object) {
      toast({
        title: 'No model to export',
        description: 'Build or open a model first.',
        variant: 'destructive',
      });
      return;
    }
    const abort = new AbortController();
    active.current = abort;
    setBusy(true);
    setProgress(null);
    setComparisonPng(null);
    try {
      let firstFrame: ImageData | undefined;
      const state = get();
      const controls = state.controls as OrbitControlsLike | null;
      const result = await withPausedOrbitPreview(
        {
          frameloop: state.frameloop,
          setFrameloop: state.setFrameloop,
          invalidate: state.invalidate,
          controls,
        },
        async () => {
          // No encoder/export core is loaded before the first explicit click.
          const { exportOrbitGif, normalizeGifFilename, visibleOrbitBounds } =
            await import('@/utils/exportOrbitGif');
          abort.signal.throwIfAborted();
          const { createOrbitStudio } = await import(
            '@/utils/orbitStudioScene'
          );
          // PNG uses the interactive scene's lights, environment and materials.
          const studio = createOrbitStudio(
            object,
            visibleOrbitBounds(object, state.camera),
            format === 'png' ? state.scene : undefined,
          );
          try {
            const content = await exportOrbitGif({
              format,
              renderer: state.gl,
              scene: studio.scene,
              camera: state.camera,
              object: studio.object,
              controls: controls ?? undefined,
              pixelRatio: 2,
              fillRatio: fillPercent / 100,
              onFirstFrame:
                includePng && format === 'gif'
                  ? (rgba, width, height) => {
                      firstFrame = new ImageData(
                        new Uint8ClampedArray(rgba),
                        width,
                        height,
                      );
                    }
                  : undefined,
              onProgress: (next) => {
                abort.signal.throwIfAborted();
                // A route/model change invalidates this export's captured references.
                if (objectRef.current !== object)
                  throw new Error(
                    'The model changed during GIF export. Please try again.',
                  );
                setProgress(next);
              },
            });
            return {
              content,
              filename: normalizeGifFilename(
                filename.replace(/\.png$/i, ''),
                `${filenameBase}-orbit.gif`,
              ).replace(/\.gif$/i, format === 'png' ? '.png' : '.gif'),
            };
          } finally {
            studio.dispose();
          }
        },
      );
      abort.signal.throwIfAborted();
      downloadFile({
        ...result,
        mimeType: format === 'png' ? 'image/png' : 'image/gif',
      });
      if (firstFrame) {
        const canvas = document.createElement('canvas');
        canvas.width = firstFrame.width;
        canvas.height = firstFrame.height;
        const context = canvas.getContext('2d');
        if (!context)
          throw new Error('Could not create comparison PNG canvas.');
        context.putImageData(firstFrame, 0, 0);
        const content = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (blob) =>
              blob
                ? resolve(blob)
                : reject(new Error('Could not encode comparison PNG.')),
            'image/png',
          ),
        );
        abort.signal.throwIfAborted();
        const png = {
          content,
          filename: result.filename.replace(/\.gif$/i, '-frame-001.png'),
        };
        setComparisonPng(png);
        downloadFile({ ...png, mimeType: 'image/png' });
      }
    } catch (error) {
      if (!abort.signal.aborted && mounted.current) {
        toast({
          title:
            format === 'png' ? 'PNG export failed' : 'Orbit GIF export failed',
          description:
            error instanceof Error
              ? error.message
              : 'Could not export the current model.',
          variant: 'destructive',
        });
      }
    } finally {
      active.current = null;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };

  return (
    <Html
      fullscreen
      calculatePosition={(_object, _camera, size) => [
        size.width / 2,
        size.height / 2,
      ]}
      zIndexRange={[100, 100]}
      style={{ pointerEvents: 'none' }}
    >
      <div
        className="absolute inset-0"
        style={{ pointerEvents: busy ? 'auto' : 'none' }}
        aria-busy={busy}
      >
        <div
          className="absolute right-3 top-[58px] flex max-w-[calc(100%-1.5rem)] flex-col gap-2 rounded-lg border bg-white/95 p-3 text-xs text-slate-800 shadow-sm"
          style={{ pointerEvents: 'auto' }}
        >
          <span className="font-medium">README images · DEV</span>
          <input
            aria-label="Export filename"
            className="w-48 max-w-full rounded border px-2 py-1"
            value={filename}
            disabled={busy}
            onChange={(event) => setCustomFilename(event.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            className="rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-60"
            onClick={() => void startExport()}
          >
            Export orbit GIF
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded border px-3 py-2 disabled:opacity-60"
            onClick={() => void startExport('png')}
          >
            Export visible PNG
          </button>
          <span>PNG：仅导出可见部件，保留当前观察方向</span>
          <label className="flex flex-col gap-1">
            <span>模型取景占比：{fillPercent}%</span>
            <input
              aria-label="模型取景占比"
              type="range"
              min={75}
              max={96}
              step={1}
              value={fillPercent}
              disabled={busy}
              onChange={(event) => setFillPercent(Number(event.target.value))}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includePng}
              disabled={busy}
              onChange={(event) => setIncludePng(event.target.checked)}
            />
            同时下载对照 PNG（第一帧）
          </label>
          {comparisonPng && (
            <button
              type="button"
              disabled={busy}
              className="rounded border px-2 py-1 disabled:opacity-60"
              onClick={() =>
                downloadFile({ ...comparisonPng, mimeType: 'image/png' })
              }
            >
              重新下载对照 PNG
            </button>
          )}
          <span role="status" aria-live="polite">
            {busy
              ? progress
                ? `${progress.stage === 'rendering' ? 'Rendering' : 'Encoding'} ${progress.completed} / ${progress.total}`
                : 'Preparing…'
              : '520 × 520 · 36 frames · 2× supersampling'}
          </span>
        </div>
      </div>
    </Html>
  );
}

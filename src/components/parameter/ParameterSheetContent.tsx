import { Download, ChevronUp, Loader2 } from 'lucide-react';
import { useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Parameter } from '@shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ParameterInput } from '@/components/parameter/ParameterInput';
import { AssemblyComponentVisibility } from '@/components/parameter/AssemblyComponentVisibility';
import type { ParameterChangeHandler } from '@/components/parameter/parameterChangeTiming';
import type { AssemblyComponent } from '@shared/assemblyContract';
import { validateParameterValue } from '@/utils/parameterUtils';
import type { StepExporter } from '@/utils/downloadUtils';
import { useCadExport } from '@/components/viewer/useCadExport';

interface ParameterSheetContentProps {
  parameters: Parameter[];
  onParameterChange: ParameterChangeHandler;
  currentOutput?: Blob;
  stepExporter?: StepExporter | null;
  stlExporter?: StepExporter | null;
  code?: string;
  filenameBase?: string;
  assemblyComponents?: AssemblyComponent[];
  assemblyVisibility?: Record<string, boolean>;
  onAssemblyVisibilityChange?: (next: Record<string, boolean>) => void;
  parametersReadOnly?: boolean;
}

export function ParameterSheetContent({
  parameters,
  onParameterChange,
  currentOutput,
  stepExporter,
  stlExporter,
  code,
  filenameBase,
  assemblyComponents = [],
  assemblyVisibility = {},
  onAssemblyVisibilityChange,
  parametersReadOnly = false,
}: ParameterSheetContentProps) {
  const {
    selectedFormat,
    setSelectedFormat,
    isExporting,
    formatAvailable,
    isAnyFormatAvailable,
    exportSelected,
  } = useCadExport({
    currentOutput,
    stepExporter,
    stlExporter,
    code,
    filenameBase,
  });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingParametersRef = useRef<Parameter[] | null>(null);
  const pendingChangeStartedAtRef = useRef<number | null>(null);
  const latestParametersRef = useRef(parameters);

  useEffect(() => {
    latestParametersRef.current = parameters;
  }, [parameters]);

  // Always flush through the latest callback — the unmount flush below runs
  // with `[]` deps, so without this ref it would call a stale closure.
  const onParameterChangeRef = useRef(onParameterChange);
  useEffect(() => {
    onParameterChangeRef.current = onParameterChange;
  }, [onParameterChange]);

  // On unmount, flush any pending debounced edit instead of dropping it. The
  // editor remounts on `key={conversation.id}`, so an edit made within the
  // 200ms window just before navigating away would otherwise be lost.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (pendingParametersRef.current) {
        const startedAt =
          pendingChangeStartedAtRef.current ?? performance.now();
        onParameterChangeRef.current(pendingParametersRef.current, {
          started_at_ms: startedAt,
          debounce_ms: performance.now() - startedAt,
        });
        pendingChangeStartedAtRef.current = null;
        pendingParametersRef.current = null;
      }
    };
  }, []);

  const debouncedSubmit = useCallback(
    (params: Parameter[]) => {
      pendingParametersRef.current = params;
      pendingChangeStartedAtRef.current = performance.now();

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        if (pendingParametersRef.current) {
          const startedAt =
            pendingChangeStartedAtRef.current ?? performance.now();
          onParameterChange(pendingParametersRef.current, {
            started_at_ms: startedAt,
            debounce_ms: performance.now() - startedAt,
          });
          pendingChangeStartedAtRef.current = null;
          latestParametersRef.current = pendingParametersRef.current;
          pendingParametersRef.current = null;
        }
      }, 200);
    },
    [onParameterChange],
  );

  const handleCommit = (param: Parameter, value: Parameter['value']) => {
    if (parametersReadOnly) return;
    const validatedValue = validateParameterValue(param, value);
    const updatedParam = { ...param, value: validatedValue };
    const baseParameters =
      pendingParametersRef.current ?? latestParametersRef.current;
    const updatedParameters = baseParameters.map((p) =>
      p.name === param.name ? updatedParam : p,
    );

    debouncedSubmit(updatedParameters);
  };

  const isDownloadDisabled = !formatAvailable[selectedFormat];

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ScrollArea className="min-h-0 w-full flex-1 px-4">
        <div className="flex flex-col gap-6 pb-4 pt-2">
          {parametersReadOnly && parameters.length > 0 ? (
            <div className="rounded-md border border-adam-neutral-700 bg-adam-neutral-900 px-3 py-2 text-xs text-adam-neutral-300">
              Historical parameters are read-only. Restore this version to edit
              them.
            </div>
          ) : null}
          <div
            className={
              parametersReadOnly
                ? 'pointer-events-none flex flex-col gap-6 opacity-60'
                : 'flex flex-col gap-6'
            }
          >
            {parameters.map((param) => (
              <ParameterInput
                key={param.name}
                param={param}
                handleCommit={handleCommit}
              />
            ))}
          </div>
          {onAssemblyVisibilityChange && (
            <AssemblyComponentVisibility
              components={assemblyComponents}
              visibility={assemblyVisibility}
              onChange={onAssemblyVisibilityChange}
            />
          )}
        </div>
      </ScrollArea>
      <div className="flex w-full flex-col gap-4 p-4">
        <div className="flex border-t border-adam-neutral-700 pt-2">
          <Button
            onClick={() => void exportSelected()}
            disabled={isDownloadDisabled}
            aria-label={`download ${selectedFormat.toUpperCase()} file`}
            className="flex-1 rounded-r-none bg-adam-neutral-50 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
          >
            {isExporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {selectedFormat.toUpperCase()}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                disabled={!isAnyFormatAvailable}
                aria-label="select download format"
                className="rounded-l-none border-l border-adam-neutral-300 bg-adam-neutral-50 px-2 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('step')}
                  disabled={!formatAvailable.step}
                  className="grid cursor-pointer grid-cols-3 text-adam-text-primary"
                >
                  <span className="text-sm">.STEP</span>
                  <span className="col-span-2 text-xs text-adam-text-primary/60">
                    CAD exchange (preferred)
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('stl')}
                  disabled={!formatAvailable.stl}
                  className="grid cursor-pointer grid-cols-3 text-adam-text-primary"
                >
                  <span className="text-sm">.STL</span>
                  <span className="col-span-2 text-xs text-adam-text-primary/60">
                    3D Printing
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('py')}
                  disabled={!formatAvailable.py}
                  className="grid cursor-pointer grid-cols-3 text-adam-text-primary"
                >
                  <span className="text-sm">.PY</span>
                  <span className="col-span-2 text-xs text-adam-text-primary/60">
                    SimpleCADAPI source
                  </span>
                </DropdownMenuItem>
              </>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

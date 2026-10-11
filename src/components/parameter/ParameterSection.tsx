import {
  RefreshCcw,
  Download,
  ChevronUp,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Parameter } from '@shared/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ParameterInput } from '@/components/parameter/ParameterInput';
import { AssemblyComponentVisibility } from '@/components/parameter/AssemblyComponentVisibility';
import type { ParameterChangeHandler } from '@/components/parameter/parameterChangeTiming';
import type { AssemblyComponent } from '@shared/assemblyContract';
import {
  validateParameterValue,
  isColorParameter,
} from '@/utils/parameterUtils';
import type { StepExporter } from '@/utils/downloadUtils';
import { useCadExport } from '@/components/viewer/useCadExport';

interface ParameterSectionProps {
  parameters: Parameter[];
  onParameterChange: ParameterChangeHandler;
  currentOutput?: Blob;
  /** When set, enables STEP download (SimpleCADAPI MVP 3.2). */
  stepExporter?: StepExporter | null;
  /** On-demand STL when prefetch blob is not ready yet. */
  stlExporter?: StepExporter | null;
  code?: string;
  filenameBase?: string;
  assemblyComponents?: AssemblyComponent[];
  assemblyVisibility?: Record<string, boolean>;
  onAssemblyVisibilityChange?: (next: Record<string, boolean>) => void;
  /** Historical CAD versions are immutable until restored as the branch leaf. */
  parametersReadOnly?: boolean;
}

export function ParameterSection({
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
}: ParameterSectionProps) {
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

  // Split params into the main list (non-color, shown by default) and a
  // collapsible Colors group below it. Keeps the dimensions the user
  // usually wants front-and-center while colors stay one click away.
  const { mainParameters, colorParameters } = useMemo(() => {
    const main: Parameter[] = [];
    const color: Parameter[] = [];
    for (const p of parameters) {
      if (isColorParameter(p)) color.push(p);
      else main.push(p);
    }
    return { mainParameters: main, colorParameters: color };
  }, [parameters]);
  const [colorsOpen, setColorsOpen] = useState(true);
  const [dimensionsOpen, setDimensionsOpen] = useState(true);

  // Debounce timer for compilation
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingParametersRef = useRef<Parameter[] | null>(null);
  const pendingChangeStartedAtRef = useRef<number | null>(null);

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

  // Debounced submit function
  const debouncedSubmit = useCallback(
    (params: Parameter[]) => {
      // Store the parameters to submit
      pendingParametersRef.current = params;
      pendingChangeStartedAtRef.current = performance.now();

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set new debounced timer (200ms delay)
      debounceTimerRef.current = setTimeout(() => {
        if (pendingParametersRef.current) {
          const startedAt =
            pendingChangeStartedAtRef.current ?? performance.now();
          onParameterChange(pendingParametersRef.current, {
            started_at_ms: startedAt,
            debounce_ms: performance.now() - startedAt,
          });
          pendingChangeStartedAtRef.current = null;
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
    const updatedParameters = parameters.map((p) =>
      p.name === param.name ? updatedParam : p,
    );

    debouncedSubmit(updatedParameters);
  };

  const isDownloadDisabled = !formatAvailable[selectedFormat];

  return (
    <div className="h-full w-full max-w-full border-l border-gray-200/20 bg-adam-bg-secondary-dark dark:border-gray-800">
      <div className="flex h-14 items-center justify-between border-b border-adam-neutral-700 bg-gradient-to-r from-adam-bg-secondary-dark to-adam-bg-secondary-dark/95 px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold tracking-tight text-adam-text-primary">
            Parameters
          </span>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="h-8 w-8 rounded-full p-0 text-adam-text-primary transition-colors [@media(hover:hover)]:hover:bg-adam-neutral-950 [@media(hover:hover)]:hover:text-adam-neutral-10"
                disabled={parameters.length === 0 || parametersReadOnly}
                onClick={() => {
                  const newParameters = parameters.map((param) => ({
                    ...param,
                    value: param.defaultValue,
                  }));
                  onParameterChange(newParameters);
                }}
              >
                <RefreshCcw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Reset all parameters</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex h-[calc(100%-3.5rem)] flex-col justify-between overflow-hidden">
        <ScrollArea className="flex-1 px-6 py-6">
          <div className="flex flex-col gap-3">
            {parametersReadOnly && parameters.length > 0 ? (
              <div className="rounded-md border border-adam-neutral-700 bg-adam-neutral-900 px-3 py-2 text-xs text-adam-neutral-300">
                Historical parameters are read-only. Restore this version to
                edit them.
              </div>
            ) : null}
            {mainParameters.length > 0 && (
              <Collapsible
                open={dimensionsOpen}
                onOpenChange={setDimensionsOpen}
              >
                <CollapsibleTrigger
                  aria-label={`${dimensionsOpen ? 'Collapse' : 'Expand'} dimension parameters`}
                  className="group flex w-full items-center justify-between gap-2 rounded-md py-1 text-xs font-semibold text-adam-text-primary transition-colors focus:outline-none"
                >
                  <span className="flex items-center gap-2">
                    Dimensions
                    <span className="text-[10px] text-adam-neutral-400">
                      {mainParameters.length}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-adam-neutral-400 transition-all duration-200 group-hover:text-adam-text-primary ${
                      dimensionsOpen ? 'rotate-180' : ''
                    }`}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
                  <div
                    className={
                      parametersReadOnly
                        ? 'pointer-events-none mt-3 flex flex-col gap-3 opacity-60'
                        : 'mt-3 flex flex-col gap-3'
                    }
                  >
                    {mainParameters.map((param) => (
                      <ParameterInput
                        key={param.name}
                        param={param}
                        handleCommit={handleCommit}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            {colorParameters.length > 0 && (
              <Collapsible
                open={colorsOpen}
                onOpenChange={setColorsOpen}
                className="mt-3 border-t border-adam-neutral-700/60 pt-3"
              >
                <CollapsibleTrigger
                  aria-label={`${colorsOpen ? 'Collapse' : 'Expand'} color parameters`}
                  className="group flex w-full items-center justify-between gap-2 rounded-md py-1 text-xs font-semibold text-adam-text-primary transition-colors focus:outline-none"
                >
                  <span className="flex items-center gap-2">
                    Colors
                    <span className="text-[10px] text-adam-neutral-400">
                      {colorParameters.length}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-adam-neutral-400 transition-all duration-200 group-hover:text-adam-text-primary ${
                      colorsOpen ? 'rotate-180' : ''
                    }`}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
                  <div
                    className={
                      parametersReadOnly
                        ? 'pointer-events-none mt-3 flex flex-col gap-3 opacity-60'
                        : 'mt-3 flex flex-col gap-3'
                    }
                  >
                    {colorParameters.map((param) => (
                      <ParameterInput
                        key={param.name}
                        param={param}
                        handleCommit={handleCommit}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            {onAssemblyVisibilityChange && (
              <AssemblyComponentVisibility
                components={assemblyComponents}
                visibility={assemblyVisibility}
                onChange={onAssemblyVisibilityChange}
              />
            )}
          </div>
        </ScrollArea>
        <div className="flex flex-col gap-4 border-t border-adam-neutral-700 px-6 py-6">
          <div className="flex">
            <Button
              onClick={() => void exportSelected()}
              disabled={isDownloadDisabled}
              aria-label={`download ${selectedFormat.toUpperCase()} file`}
              className="h-12 flex-1 rounded-r-none bg-adam-neutral-50 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
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
                  className="h-12 w-12 rounded-l-none border-l border-adam-neutral-300 bg-adam-neutral-50 p-0 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-64 border-none bg-adam-neutral-800 shadow-md"
              >
                <>
                  <DropdownMenuItem
                    onClick={() => setSelectedFormat('step')}
                    disabled={!formatAvailable.step}
                    className="cursor-pointer text-adam-text-primary"
                  >
                    <span className="text-sm">.STEP</span>
                    <span className="ml-3 text-xs text-adam-text-primary/60">
                      CAD exchange (preferred)
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setSelectedFormat('stl')}
                    disabled={!formatAvailable.stl}
                    className="cursor-pointer text-adam-text-primary"
                  >
                    <span className="text-sm">.STL</span>
                    <span className="ml-3 text-xs text-adam-text-primary/60">
                      3D Printing
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setSelectedFormat('py')}
                    disabled={!formatAvailable.py}
                    className="cursor-pointer text-adam-text-primary"
                  >
                    <span className="text-sm">.PY</span>
                    <span className="ml-3 text-xs text-adam-text-primary/60">
                      SimpleCADAPI source
                    </span>
                  </DropdownMenuItem>
                </>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}

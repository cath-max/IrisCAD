import { ChevronDown, RefreshCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssemblyComponentVisibility } from '@/components/parameter/AssemblyComponentVisibility';
import { ParameterInput } from '@/components/parameter/ParameterInput';
import type { ParameterChangeHandler } from '@/components/parameter/parameterChangeTiming';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AssemblyComponent } from '@shared/assemblyContract';
import type { Parameter } from '@shared/types';
import {
  isColorParameter,
  validateParameterValue,
} from '@/utils/parameterUtils';

type IrisModelPanelProps = {
  parameters: Parameter[];
  onParameterChange: ParameterChangeHandler;
  assemblyComponents?: AssemblyComponent[];
  assemblyVisibility?: Record<string, boolean>;
  onAssemblyVisibilityChange?: (next: Record<string, boolean>) => void;
  parametersReadOnly?: boolean;
};

/**
 * Iris' desktop Model tab. It intentionally owns no CAD/export state: the
 * existing parameter callback and Assembly visibility callback remain the
 * single source of truth in EditorView.
 */
export function IrisModelPanel({
  parameters,
  onParameterChange,
  assemblyComponents = [],
  assemblyVisibility = {},
  onAssemblyVisibilityChange,
  parametersReadOnly = false,
}: IrisModelPanelProps) {
  const [parametersOpen, setParametersOpen] = useState(true);
  const latestParametersRef = useRef(parameters);
  const pendingParametersRef = useRef<Parameter[] | null>(null);
  const pendingChangeStartedAtRef = useRef<number | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onParameterChangeRef = useRef(onParameterChange);

  // Model deliberately omits colors; Appearance/Colors remain outside this
  // information architecture even if legacy models still contain them.
  const editableParameters = useMemo(
    () => parameters.filter((parameter) => !isColorParameter(parameter)),
    [parameters],
  );

  useEffect(() => {
    latestParametersRef.current = parameters;
  }, [parameters]);

  useEffect(() => {
    onParameterChangeRef.current = onParameterChange;
  }, [onParameterChange]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (!pendingParametersRef.current) return;
      const startedAt = pendingChangeStartedAtRef.current ?? performance.now();
      onParameterChangeRef.current(pendingParametersRef.current, {
        started_at_ms: startedAt,
        debounce_ms: performance.now() - startedAt,
      });
    };
  }, []);

  const submitDebounced = useCallback(
    (nextParameters: Parameter[]) => {
      pendingParametersRef.current = nextParameters;
      pendingChangeStartedAtRef.current = performance.now();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        if (!pendingParametersRef.current) return;
        const startedAt =
          pendingChangeStartedAtRef.current ?? performance.now();
        onParameterChange(pendingParametersRef.current, {
          started_at_ms: startedAt,
          debounce_ms: performance.now() - startedAt,
        });
        latestParametersRef.current = pendingParametersRef.current;
        pendingParametersRef.current = null;
        pendingChangeStartedAtRef.current = null;
      }, 200);
    },
    [onParameterChange],
  );

  const handleCommit = useCallback(
    (parameter: Parameter, value: Parameter['value']) => {
      if (parametersReadOnly) return;
      const updatedParameter = {
        ...parameter,
        value: validateParameterValue(parameter, value),
      };
      const source =
        pendingParametersRef.current ?? latestParametersRef.current;
      submitDebounced(
        source.map((current) =>
          current.name === parameter.name ? updatedParameter : current,
        ),
      );
    },
    [parametersReadOnly, submitDebounced],
  );

  const resetParameters = useCallback(() => {
    if (parametersReadOnly) return;
    onParameterChange(
      parameters.map((parameter) => ({
        ...parameter,
        value: parameter.defaultValue,
      })),
    );
  }, [onParameterChange, parameters, parametersReadOnly]);

  const hasComponents =
    !!onAssemblyVisibilityChange && assemblyComponents.length > 0;
  const hasEditableContent = editableParameters.length > 0 || hasComponents;

  return (
    <section className="iris-model-panel" aria-label="Model controls">
      <ScrollArea className="h-full w-full">
        <div className="iris-model-panel__content">
          {parametersReadOnly && editableParameters.length > 0 ? (
            <p className="iris-model-panel__notice" role="status">
              Historical parameters are read-only. Restore this version to edit.
            </p>
          ) : null}

          {editableParameters.length > 0 ? (
            <Collapsible open={parametersOpen} onOpenChange={setParametersOpen}>
              <div className="iris-model-section">
                <CollapsibleTrigger
                  className="iris-model-section__trigger"
                  aria-label={`${parametersOpen ? 'Collapse' : 'Expand'} parameters`}
                >
                  <span>
                    Parameters <small>{editableParameters.length}</small>
                  </span>
                  <ChevronDown data-open={parametersOpen} aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div
                    className={
                      parametersReadOnly
                        ? 'iris-model-section__fields pointer-events-none opacity-60'
                        : 'iris-model-section__fields'
                    }
                  >
                    {editableParameters.map((parameter) => (
                      <ParameterInput
                        key={parameter.name}
                        param={parameter}
                        handleCommit={handleCommit}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="iris-model-reset"
                  disabled={parametersReadOnly}
                  onClick={resetParameters}
                >
                  <RefreshCcw aria-hidden="true" />
                  Reset all
                </Button>
              </div>
            </Collapsible>
          ) : null}

          {hasComponents ? (
            <AssemblyComponentVisibility
              components={assemblyComponents}
              visibility={assemblyVisibility}
              onChange={onAssemblyVisibilityChange}
            />
          ) : null}

          {!hasEditableContent ? (
            <p className="iris-model-panel__empty" role="status">
              No editable model controls
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}

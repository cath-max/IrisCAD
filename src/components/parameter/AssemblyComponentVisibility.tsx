import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import type { AssemblyComponent } from '@shared/assemblyContract';

export function AssemblyComponentVisibility({
  components,
  visibility,
  onChange,
}: {
  components: AssemblyComponent[];
  visibility: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
}) {
  const [open, setOpen] = useState(true);
  if (components.length === 0) return null;
  const setAll = (visible: boolean) =>
    onChange(
      Object.fromEntries(
        components.map((component) => [component.component_id, visible]),
      ),
    );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="iris-model-section iris-model-components">
        <CollapsibleTrigger
          className="iris-model-section__trigger"
          aria-label={`${open ? 'Collapse' : 'Expand'} components`}
        >
          <span>
            Components <small>{components.length}</small>
          </span>
          <ChevronDown data-open={open} aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="iris-model-components__actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAll(true)}
            >
              Show all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAll(false)}
            >
              Hide all
            </Button>
          </div>
          <div className="iris-model-components__list">
            {components.map((component) => {
              const visible = visibility[component.component_id] !== false;
              return (
                <label
                  key={component.component_id}
                  className="iris-model-component"
                >
                  <span className="min-w-0">
                    <span>{component.component_name}</span>
                    <small>{component.component_id}</small>
                  </span>
                  <span className="iris-model-component__visibility">
                    {visible ? (
                      <Eye aria-hidden="true" />
                    ) : (
                      <EyeOff aria-hidden="true" />
                    )}
                    <Switch
                      checked={visible}
                      onCheckedChange={(next) =>
                        onChange({
                          ...visibility,
                          [component.component_id]: next,
                        })
                      }
                    />
                  </span>
                </label>
              );
            })}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

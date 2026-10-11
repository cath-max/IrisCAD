import {
  validateAssemblySourceLayout,
  type AssemblySourceSection,
  type AssemblySourceSectionKind,
} from './assemblySourceLayout.ts';
import type { ParametricModelSnapshot } from './modelSnapshot.ts';

export const DEFAULT_LOCAL_PATCH_COMPONENT_LIMIT = 6;

export type AssemblyPatchTarget =
  | { kind: 'component'; componentId: string; change: 'placement' }
  | { kind: 'part'; partId: string; change: 'geometry' }
  | { kind: 'parameter'; parameterName: string; change: 'value' }
  | { kind: 'helper'; helperId: string; change: 'implementation' };

export type AssemblyPatchScope = {
  target: AssemblyPatchTarget;
  /** Sections the model may replace in a patch. Dependencies are read-only. */
  editableSections: AssemblySourceSection[];
  /** Additional source required to understand an approved local change. */
  dependencySections: AssemblySourceSection[];
  affectedComponentIds: string[];
};

export type AssemblyPatchScopeDecision =
  | { mode: 'local'; scope: AssemblyPatchScope }
  | { mode: 'rebuild'; reason: string }
  | { mode: 'clarify'; reason: string };

type SectionIndex = {
  sections: AssemblySourceSection[];
  byKey: Map<string, AssemblySourceSection>;
  definitions: Map<string, AssemblySourceSection[]>;
};

const PYTHON_KEYWORDS = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield',
]);
const DYNAMIC_REFERENCE_RE =
  /\b(?:eval|exec|globals|locals|getattr|setattr|__import__)\s*\(/;

/**
 * Decide whether a known Assembly target has a bounded, mechanically
 * traceable local-edit scope. Natural-language target selection stays with
 * the LLM; this function verifies the selected ID against persisted facts.
 */
export function analyzeAssemblyPatchScope({
  code,
  snapshot,
  target,
  componentLimit = DEFAULT_LOCAL_PATCH_COMPONENT_LIMIT,
}: {
  code: string;
  snapshot: ParametricModelSnapshot;
  target: AssemblyPatchTarget;
  componentLimit?: number;
}): AssemblyPatchScopeDecision {
  if (snapshot.artifactKind !== 'assembly') {
    return {
      mode: 'rebuild',
      reason: 'Local patches currently support Assembly artifacts only.',
    };
  }
  if (!Number.isInteger(componentLimit) || componentLimit < 1) {
    throw new Error('componentLimit must be a positive integer.');
  }

  const validation = validateAssemblySourceLayout(code);
  if (!validation.ok) {
    return {
      mode: 'rebuild',
      reason:
        'The current Assembly source lacks a valid stable section layout.',
    };
  }
  if (DYNAMIC_REFERENCE_RE.test(code)) {
    return {
      mode: 'rebuild',
      reason:
        'The current source uses dynamic Python references, so dependency impact cannot be proven locally.',
    };
  }

  const index = buildSectionIndex(validation.layout.sections);
  const componentsById = new Map(
    snapshot.components.map((component) => [component.component_id, component]),
  );
  const rootSections: AssemblySourceSection[] = [];
  let affectedComponentIds: string[] = [];

  if (target.kind === 'component') {
    const component = componentsById.get(target.componentId);
    const section = index.byKey.get(
      sectionKey('component', target.componentId),
    );
    if (!component || !section) {
      return {
        mode: 'clarify',
        reason: `No current Assembly component uniquely matches \`${target.componentId}\`.`,
      };
    }
    rootSections.push(section);
    affectedComponentIds = [component.component_id];
  } else if (target.kind === 'part') {
    const section = index.byKey.get(sectionKey('part', target.partId));
    if (!section) {
      return {
        mode: 'clarify',
        reason: `No current Assembly Part uniquely matches \`${target.partId}\`.`,
      };
    }
    rootSections.push(section);
    affectedComponentIds = componentIdsForPart(snapshot, target.partId);
    if (affectedComponentIds.length === 0) {
      return {
        mode: 'rebuild',
        reason: `Part \`${target.partId}\` is not referenced by a current component.`,
      };
    }
  } else if (target.kind === 'helper') {
    const section = index.byKey.get(sectionKey('helper', target.helperId));
    if (!section) {
      return {
        mode: 'clarify',
        reason: `No current Assembly helper uniquely matches \`${target.helperId}\`.`,
      };
    }
    rootSections.push(section);
  } else {
    const parameterSection = index.byKey.get(
      sectionKey('parameters', 'parameters'),
    );
    if (
      !parameterSection ||
      !definesName(parameterSection.source, target.parameterName)
    ) {
      return {
        mode: 'clarify',
        reason: `No current exposed parameter uniquely matches \`${target.parameterName}\`.`,
      };
    }
    rootSections.push(parameterSection);
  }

  const reachable = collectDependentSections(index, rootSections, target);
  if (target.kind === 'parameter' || target.kind === 'helper') {
    affectedComponentIds = affectedComponentsForSections(snapshot, reachable);
    if (affectedComponentIds.length === 0) {
      return {
        mode: 'rebuild',
        reason:
          target.kind === 'parameter'
            ? `Parameter \`${target.parameterName}\` has no traceable component impact.`
            : `Helper \`${target.helperId}\` has no traceable component impact.`,
      };
    }
  }

  const uniqueAffected = [...new Set(affectedComponentIds)].sort();
  if (uniqueAffected.length > componentLimit) {
    return {
      mode: 'rebuild',
      reason: `The requested change affects ${uniqueAffected.length} components, above the local limit of ${componentLimit}.`,
    };
  }

  const editableSections = selectEditableSections(reachable, target);
  const editableKeys = new Set(
    editableSections.map((section) => sectionKey(section.kind, section.id)),
  );
  return {
    mode: 'local',
    scope: {
      target,
      editableSections,
      dependencySections: reachable.filter(
        (section) => !editableKeys.has(sectionKey(section.kind, section.id)),
      ),
      affectedComponentIds: uniqueAffected,
    },
  };
}

/** Compact catalog for the future Local Patch Workset; it exposes no source. */
export function assemblyPatchTargetCatalog(
  snapshot: ParametricModelSnapshot,
  code?: string,
) {
  const layout = code ? validateAssemblySourceLayout(code) : null;
  return {
    components: snapshot.components.map((component) => ({
      componentId: component.component_id,
      componentName: component.component_name,
      partId: component.part_id,
      partName: component.part_name,
    })),
    parameters: snapshot.parameters.map((parameter) => parameter.name),
    helpers: layout?.ok
      ? layout.layout.sections
          .filter((section) => section.kind === 'helper')
          .map((section) => section.id)
      : [],
  };
}

function buildSectionIndex(sections: AssemblySourceSection[]): SectionIndex {
  const byKey = new Map<string, AssemblySourceSection>();
  const definitions = new Map<string, AssemblySourceSection[]>();
  for (const section of sections) {
    byKey.set(sectionKey(section.kind, section.id), section);
    for (const name of definedNames(section.source)) {
      const existing = definitions.get(name) ?? [];
      existing.push(section);
      definitions.set(name, existing);
    }
  }
  return { sections, byKey, definitions };
}

function collectDependentSections(
  index: SectionIndex,
  rootSections: AssemblySourceSection[],
  target: AssemblyPatchTarget,
): AssemblySourceSection[] {
  const selected = new Map<string, AssemblySourceSection>();
  const queue = [...rootSections];
  for (const section of rootSections)
    selected.set(sectionKey(section.kind, section.id), section);

  // Parameters and helpers flow into their consumers. A helper edit must
  // expose every downstream Part that calls it, so its component impact stays
  // bounded and the helper itself can be the sole editable section.
  if (target.kind === 'parameter') {
    const parameter = target.parameterName;
    for (const section of index.sections) {
      if (
        section.kind === 'parameters' ||
        !referencesName(section.source, parameter)
      )
        continue;
      const key = sectionKey(section.kind, section.id);
      if (!selected.has(key)) {
        selected.set(key, section);
        queue.push(section);
      }
    }
  } else if (target.kind === 'helper') {
    const affectedNames = new Set(
      rootSections.flatMap((section) => definedNames(section.source)),
    );
    let added = true;
    while (added) {
      added = false;
      for (const section of index.sections) {
        if (
          selected.has(sectionKey(section.kind, section.id)) ||
          (section.kind !== 'helper' && section.kind !== 'part') ||
          ![...affectedNames].some((name) =>
            referencesName(section.source, name),
          )
        )
          continue;
        selected.set(sectionKey(section.kind, section.id), section);
        queue.push(section);
        definedNames(section.source).forEach((name) => affectedNames.add(name));
        added = true;
      }
    }
  }

  while (queue.length > 0) {
    const section = queue.shift();
    if (!section) continue;
    for (const identifier of referencedNames(section.source)) {
      for (const definition of index.definitions.get(identifier) ?? []) {
        // Reading another Part or Component makes the edit structurally broad;
        // include it as context so the caller can reject it as non-local later.
        const key = sectionKey(definition.kind, definition.id);
        if (!selected.has(key)) {
          selected.set(key, definition);
          queue.push(definition);
        }
      }
    }
  }
  return index.sections.filter((section) =>
    selected.has(sectionKey(section.kind, section.id)),
  );
}

function selectEditableSections(
  sections: AssemblySourceSection[],
  target: AssemblyPatchTarget,
): AssemblySourceSection[] {
  if (target.kind === 'component') {
    return sections.filter(
      (section) =>
        section.kind === 'component' && section.id === target.componentId,
    );
  }
  if (target.kind === 'part') {
    return sections.filter(
      (section) => section.kind === 'part' && section.id === target.partId,
    );
  }
  if (target.kind === 'helper') {
    return sections.filter(
      (section) => section.kind === 'helper' && section.id === target.helperId,
    );
  }
  return sections.filter(
    (section) => section.kind === 'parameters' && section.id === 'parameters',
  );
}

function affectedComponentsForSections(
  snapshot: ParametricModelSnapshot,
  sections: AssemblySourceSection[],
): string[] {
  const componentIds = new Set<string>();
  const partIds = new Set(
    sections
      .filter((section) => section.kind === 'part')
      .map((section) => section.id),
  );
  for (const section of sections) {
    if (section.kind === 'component') componentIds.add(section.id);
  }
  for (const component of snapshot.components) {
    if (component.part_id && partIds.has(component.part_id)) {
      componentIds.add(component.component_id);
    }
  }
  return [...componentIds];
}

function componentIdsForPart(
  snapshot: ParametricModelSnapshot,
  partId: string,
): string[] {
  return snapshot.components
    .filter((component) => component.part_id === partId)
    .map((component) => component.component_id);
}

function sectionKey(kind: AssemblySourceSectionKind, id: string): string {
  return `${kind}/${id}`;
}

function definedNames(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    const functionMatch = line.match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/);
    const assignmentMatch = line.match(/^\s*([A-Za-z_]\w*)\s*=/);
    const name = functionMatch?.[1] ?? assignmentMatch?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

function definesName(source: string, name: string): boolean {
  return definedNames(source).includes(name);
}

function referencesName(source: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(
    stripDefinitionLines(source),
  );
}

function referencedNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of stripDefinitionLines(source).matchAll(
    /\b[A-Za-z_]\w*\b/g,
  )) {
    const name = match[0];
    if (!PYTHON_KEYWORDS.has(name)) names.add(name);
  }
  return [...names];
}

function stripDefinitionLines(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*def\s+[A-Za-z_]\w*\s*\(/.test(line)) return '';
      // Keep an assignment's right-hand side: `solid = make_box(width, …)`
      // still depends on `width`, even though it defines `solid`.
      return line.replace(/^\s*[A-Za-z_]\w*\s*=\s*/, '');
    })
    .join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

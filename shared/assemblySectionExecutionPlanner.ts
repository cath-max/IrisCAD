import {
  assemblySectionKey,
  type AssemblySectionAnalysisResult,
  type AssemblySectionDependencyAnalysis,
  type AssemblySectionExecutionPlan,
  type AssemblySectionFullExecutionPlan,
  type AssemblySectionIdentity,
  type AssemblySectionKey,
} from './assemblySectionExecution.ts';
import {
  validateAssemblySourceLayout,
  type AssemblySourceSection,
} from './assemblySourceLayout.ts';

export type AssemblySectionExecutionPlanningInput = {
  next_source: string;
  analysis: AssemblySectionAnalysisResult;
  previous_successful_artifact_version: string;
  next_artifact_version: string;
  change: AssemblySectionChangeOrigin;
};

export type AssemblySectionChange = {
  operation: 'replace' | 'add' | 'delete';
  sectionKey: AssemblySectionKey;
};

/** The two product entry points share one downstream section plan. */
export type AssemblySectionChangeOrigin =
  | { kind: 'parameters'; parameter_names: string[] }
  | { kind: 'sections'; section_changes: AssemblySectionChange[] };

/**
 * Produce a section plan from either changed Parameters or changed sections.
 *
 * This function is deliberately pure: it neither executes Python nor trusts
 * the plan as proof of the final geometry. Todo 5 validates that in Worker.
 */
export function planAssemblySectionExecution(
  input: AssemblySectionExecutionPlanningInput,
): AssemblySectionExecutionPlan {
  const full = (
    reason: AssemblySectionFullExecutionPlan['reason'],
    changedParameterNames: string[] = [],
  ): AssemblySectionFullExecutionPlan => ({
    mode: 'full',
    changed_parameter_names: changedParameterNames,
    reason,
    next_artifact_version: input.next_artifact_version,
  });

  const nextLayout = validateAssemblySourceLayout(input.next_source);
  if (!nextLayout.ok) return full('layout_invalid');

  const { change } = input;
  const changedParameterNames =
    change.kind === 'parameters' ? unique(change.parameter_names) : [];

  if (!input.analysis.ok)
    return full(input.analysis.error.reason, changedParameterNames);
  // These constructs can hide a dependency on any parameter, even when their
  // section is not selected. A container write is different: its direct reads
  // are still known, and unchanged sections retain their verified baseline.
  if (
    input.analysis.sections.some((section) =>
      section.unsafe_syntax.some(
        (syntax) => syntax !== 'ambiguous_in_place_mutation',
      ),
    )
  ) {
    return full('unsupported_python', changedParameterNames);
  }

  const analysisByKey = new Map(
    input.analysis.sections.map((section) => [
      assemblySectionKey(section.section),
      section,
    ]),
  );
  const layoutKeys = nextLayout.layout.sections.map((section) =>
    assemblySectionKey(section),
  );
  if (
    analysisByKey.size !== input.analysis.sections.length ||
    analysisByKey.size !== layoutKeys.length ||
    layoutKeys.some((key) => !analysisByKey.has(key))
  ) {
    return full('dependency_ambiguous', changedParameterNames);
  }

  const executableSections = nextLayout.layout.sections.filter(
    (section) => section.kind === 'helper' || section.kind === 'part',
  );
  const changedSectionChanges =
    change.kind === 'sections'
      ? uniqueSectionChanges(change.section_changes)
      : [];

  const affectedNames = new Set(changedParameterNames);
  const selected = new Set<string>();
  let requiresAssemblyTail = false;
  let executesParameters = change.kind === 'parameters';
  for (const change of changedSectionChanges) {
    if (change.operation === 'delete') {
      requiresAssemblyTail = true;
      continue;
    }
    const key = change.sectionKey;
    const section = analysisByKey.get(key);
    if (!section) return full('dependency_ambiguous', changedParameterNames);
    if (section.section.kind === 'parameters') executesParameters = true;
    if (
      section.section.kind === 'component' ||
      section.section.kind === 'assembly_setup' ||
      section.section.kind === 'assembly_result'
    ) {
      requiresAssemblyTail = true;
    }
    if (section.section.kind === 'helper' || section.section.kind === 'part')
      selected.add(key);
    section.writes.forEach((name) => affectedNames.add(name));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of executableSections) {
      const key = assemblySectionKey(section);
      const analysis = analysisByKey.get(key)!;
      if (
        selected.has(key) ||
        !analysis.reads.some((name) => affectedNames.has(name))
      ) {
        continue;
      }
      selected.add(key);
      analysis.writes.forEach((name) => affectedNames.add(name));
      changed = true;
    }
  }

  // An unrelated cycle is dormant in the already-verified baseline and is not
  // part of this snippet. Only a cycle within the requested dependency closure
  // can make this partial execution order ambiguous.
  const selectedAnalysis = executableSections
    .filter((section) => selected.has(assemblySectionKey(section)))
    .map((section) => analysisByKey.get(assemblySectionKey(section))!);
  if (hasDependencyCycle(selectedAnalysis)) {
    return full('dependency_ambiguous', changedParameterNames);
  }

  const selectedPartIds = executableSections
    .filter(
      (section) =>
        section.kind === 'part' && selected.has(assemblySectionKey(section)),
    )
    .map((section) => section.id);
  const tailStartsAt = nextLayout.layout.sections.findIndex(
    (section) => section.kind === 'assembly_setup',
  );
  const tailReadsAffectedValue = nextLayout.layout.sections
    .slice(tailStartsAt)
    .some((section) =>
      analysisByKey
        .get(assemblySectionKey(section))!
        .reads.some((name) => affectedNames.has(name)),
    );
  const needsAssemblyTail =
    requiresAssemblyTail ||
    selectedPartIds.length > 0 ||
    tailReadsAffectedValue;

  const parameterSection = nextLayout.layout.sections.find(
    (section) => section.kind === 'parameters',
  )!;
  const sectionsToExecute: AssemblySectionIdentity[] = executesParameters
    ? [identityOf(parameterSection)]
    : [];
  for (const section of executableSections) {
    if (selected.has(assemblySectionKey(section)))
      sectionsToExecute.push(identityOf(section));
  }
  if (needsAssemblyTail) {
    sectionsToExecute.push(
      ...nextLayout.layout.sections.slice(tailStartsAt).map(identityOf),
    );
  }

  // A selected container mutation could retain old keys/state across partial
  // executions, so it remains a complete-run boundary. Unselected sections
  // are not run and their successful-session state is safe to reuse.
  if (
    sectionsToExecute.some((section) =>
      analysisByKey
        .get(assemblySectionKey(section))!
        .unsafe_syntax.includes('ambiguous_in_place_mutation'),
    )
  ) {
    return full('unsupported_python', changedParameterNames);
  }

  return {
    mode: 'partial',
    changed_parameter_names: changedParameterNames,
    sections_to_execute: sectionsToExecute,
    affected_part_ids: selectedPartIds,
    previous_successful_artifact_version:
      input.previous_successful_artifact_version,
    next_artifact_version: input.next_artifact_version,
  };
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function uniqueSectionChanges(
  changes: readonly AssemblySectionChange[],
): AssemblySectionChange[] {
  const uniqueChanges = new Map<string, AssemblySectionChange>();
  for (const change of changes) {
    uniqueChanges.set(`${change.operation}:${change.sectionKey}`, change);
  }
  return [...uniqueChanges.values()];
}

function identityOf(section: AssemblySourceSection): AssemblySectionIdentity {
  return { kind: section.kind, id: section.id };
}

function hasDependencyCycle(
  sections: readonly AssemblySectionDependencyAnalysis[],
): boolean {
  const writerByName = new Map<string, string[]>();
  for (const analysis of sections) {
    const key = assemblySectionKey(analysis.section);
    for (const name of analysis.writes) {
      const writers = writerByName.get(name) ?? [];
      writers.push(key);
      writerByName.set(name, writers);
    }
  }
  const edges = new Map<string, Set<string>>();
  for (const analysis of sections) {
    const key = assemblySectionKey(analysis.section);
    const dependencies = edges.get(key) ?? new Set<string>();
    for (const name of analysis.reads) {
      // A section is the planning unit and executes atomically. Helpers in the
      // same section may legitimately call one another, so only a dependency
      // on another section can make the snippet order cyclic.
      for (const writer of writerByName.get(name) ?? []) {
        if (writer !== key) dependencies.add(writer);
      }
    }
    edges.set(key, dependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of edges.get(key) ?? [])
      if (visit(dependency)) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return [...edges.keys()].some(visit);
}

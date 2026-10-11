import type { LanguageModel, LanguageModelUsage } from 'ai';
import { generateText, Output } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { AppTools, ErrorGuidancePayload } from '@shared/chatAi';
import {
  analyzeAssemblyPatchScope,
  assemblyPatchTargetCatalog,
  type AssemblyPatchScope,
  type AssemblyPatchTarget,
} from '@shared/assemblyPatchScope';
import type { AssemblySourceSection } from '@shared/assemblySourceLayout';
import type { ParametricModelSnapshot } from '@shared/modelSnapshot';
import type {
  ParametricArtifact,
  ProtectedRebuildContract,
} from '@shared/types';
import { z } from 'zod';

export const LOCAL_EDIT_ROUTER_TIMEOUT_MS = 8_000;
export const LOCAL_EDIT_NEW_API_LIMIT = 5;

const routeSchema = z.object({
  mode: z.enum(['local', 'protected_rebuild', 'complete_rebuild', 'clarify']),
  target_type: z
    .enum([
      'component_placement',
      'component_geometry',
      'part_geometry',
      'parameter_value',
      'helper_implementation',
      'part_or_component_add_remove',
    ])
    .nullable(),
  target_id: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().min(1).max(400),
  clarification_question: z.string().max(400).nullable(),
});

type RawRoute = z.infer<typeof routeSchema>;

export type LocalEditRouteDecision =
  | { mode: 'local'; target: AssemblyPatchTarget; reason: string }
  | { mode: 'local_structure'; reason: string }
  | {
      mode: 'protected_rebuild';
      componentId: string;
      reason: string;
    }
  | { mode: 'complete_rebuild'; reason: string }
  | { mode: 'clarify'; reason: string; question: string };

export type LocalEditRouterResult = {
  decision: LocalEditRouteDecision;
  usage: LanguageModelUsage;
};

const ROUTER_SYSTEM_PROMPT = `You route one revision request for an existing CAD Assembly.

Return only the requested structured object. Use the exact IDs in the supplied catalog.

- local + component_placement: move or rotate one existing component.
- local + part_geometry: change one existing Part definition for every component that reuses it.
- local + parameter_value: change one existing exposed parameter value.
- local + helper_implementation: change one existing helper definition and every Part that calls it.
- local + part_or_component_add_remove: add or remove a few clearly named Part or Component sections. Use this only when the request is unambiguous and can stay within six affected components.
- protected_rebuild + component_geometry: the user explicitly wants only one instance of a reused Part to change shape, so that instance needs a new Part definition.
- complete_rebuild: change assembly_setup or assembly_result, change Assembly structure beyond a few Part/Component additions or removals, change artifact type, make a broad/global redesign, or perform a request with no single bounded existing target.
- clarify: the target is ambiguous, multiple IDs are plausible, it is unclear whether a shared Part should change for all instances, or it is unclear whether the request changes Placement or geometry.

Choose local only with high confidence. Never invent an ID. A component name and a Part name are different targets.`;

export async function routeAssemblyEdit({
  model,
  providerOptions,
  userText,
  snapshot,
  code,
  visionShapeText,
  abortSignal,
}: {
  model: LanguageModel;
  providerOptions?: ProviderOptions;
  userText: string;
  snapshot: ParametricModelSnapshot;
  code: string;
  visionShapeText?: string | null;
  abortSignal?: AbortSignal;
}): Promise<LocalEditRouterResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LOCAL_EDIT_ROUTER_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await generateText({
      model,
      providerOptions,
      system: ROUTER_SYSTEM_PROMPT,
      prompt: JSON.stringify({
        request: userText,
        artifact_kind: snapshot.artifactKind,
        model_summary: snapshot.modelSummary,
        recent_changes: snapshot.recentChanges,
        target_catalog: assemblyPatchTargetCatalog(snapshot, code),
        ...(visionShapeText ? { reference_shape: visionShapeText } : {}),
      }),
      output: Output.object({ schema: routeSchema }),
      maxOutputTokens: 600,
      abortSignal: controller.signal,
    });
    return {
      decision: normalizeRouteDecision(result.output, snapshot),
      usage: result.usage,
    };
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

export function normalizeRouteDecision(
  route: RawRoute,
  snapshot: ParametricModelSnapshot,
): LocalEditRouteDecision {
  if (route.mode === 'clarify' || route.confidence !== 'high') {
    return {
      mode: 'clarify',
      reason: route.reason,
      question:
        route.clarification_question?.trim() ||
        'Which existing component or Part should be changed?',
    };
  }
  if (route.mode === 'complete_rebuild') {
    return { mode: 'complete_rebuild', reason: route.reason };
  }
  if (
    route.mode === 'local' &&
    route.target_type === 'part_or_component_add_remove'
  ) {
    return { mode: 'local_structure', reason: route.reason };
  }
  if (!route.target_type || !route.target_id) {
    return {
      mode: 'clarify',
      reason: 'The router did not identify one existing target.',
      question:
        'Which existing component, Part, or parameter should be changed?',
    };
  }

  if (route.mode === 'protected_rebuild') {
    const component = snapshot.components.find(
      (item) => item.component_id === route.target_id,
    );
    if (!component?.part_id || route.target_type !== 'component_geometry') {
      return {
        mode: 'clarify',
        reason:
          'The protected rebuild target is not one current Part component.',
        question:
          'Which single component instance should receive its own modified Part?',
      };
    }
    const reuseCount = snapshot.components.filter(
      (item) => item.part_id === component.part_id,
    ).length;
    if (reuseCount < 2) {
      return {
        mode: 'local',
        target: {
          kind: 'part',
          partId: component.part_id,
          change: 'geometry',
        },
        reason: route.reason,
      };
    }
    return {
      mode: 'protected_rebuild',
      componentId: component.component_id,
      reason: route.reason,
    };
  }

  const target = targetFromRoute(route);
  if (!target) {
    return {
      mode: 'clarify',
      reason: 'The selected target type is not valid for a local patch.',
      question:
        'Should this change move a component, reshape a Part, or change a parameter?',
    };
  }
  return { mode: 'local', target, reason: route.reason };
}

function targetFromRoute(route: RawRoute): AssemblyPatchTarget | null {
  if (!route.target_id) return null;
  if (route.target_type === 'component_placement') {
    return {
      kind: 'component',
      componentId: route.target_id,
      change: 'placement',
    };
  }
  if (route.target_type === 'part_geometry') {
    return { kind: 'part', partId: route.target_id, change: 'geometry' };
  }
  if (route.target_type === 'parameter_value') {
    return {
      kind: 'parameter',
      parameterName: route.target_id,
      change: 'value',
    };
  }
  if (route.target_type === 'helper_implementation') {
    return {
      kind: 'helper',
      helperId: route.target_id,
      change: 'implementation',
    };
  }
  return null;
}

export function decideLocalPatchScope({
  artifact,
  snapshot,
  target,
}: {
  artifact: ParametricArtifact;
  snapshot: ParametricModelSnapshot;
  target: AssemblyPatchTarget;
}) {
  return analyzeAssemblyPatchScope({
    code: artifact.code,
    snapshot,
    target,
  });
}

export function buildProtectedRebuildContract(
  snapshot: ParametricModelSnapshot,
  componentId: string,
): { contract: ProtectedRebuildContract; newPartId: string } | null {
  const component = snapshot.components.find(
    (item) => item.component_id === componentId,
  );
  if (!component?.part_id) return null;
  const existingPartIds = new Set(
    snapshot.components
      .map((item) => item.part_id)
      .filter((value): value is string => Boolean(value)),
  );
  const baseId = normalizeSectionId(`${component.part_id}_${componentId}`);
  let newPartId = baseId;
  for (let suffix = 2; existingPartIds.has(newPartId); suffix += 1) {
    newPartId = `${baseId}_${suffix}`;
  }
  return {
    newPartId,
    contract: {
      base_model_revision: snapshot.modelRevision,
      replace_sections: [
        { section_kind: 'component', section_id: componentId },
      ],
      add_sections: [{ section_kind: 'part', section_id: newPartId }],
      affected_component_ids: [componentId],
      allow_mate_notes_change: false,
    },
  };
}

function normalizeSectionId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalized)
    ? normalized
    : `part_${normalized || 'copy'}`;
}

export function buildLocalPatchWorkset({
  snapshot,
  scope,
  errorGuidance,
}: {
  snapshot: ParametricModelSnapshot;
  scope: AssemblyPatchScope;
  errorGuidance?: ErrorGuidancePayload | null;
}): string {
  const lines = [
    '# Local Patch Workset',
    '',
    `base_model_revision: ${snapshot.modelRevision}`,
    `artifact_kind: ${snapshot.artifactKind}`,
    `target: ${JSON.stringify(scope.target)}`,
    `allowed_affected_component_ids: ${JSON.stringify(scope.affectedComponentIds)}`,
    '',
    '## Current model snapshot',
    `model_summary: ${snapshot.modelSummary || '(not available)'}`,
    `recent_changes: ${JSON.stringify(snapshot.recentChanges)}`,
    `parameters: ${JSON.stringify(snapshot.parameters)}`,
    `components: ${JSON.stringify(compactComponents(snapshot))}`,
    `bom: ${JSON.stringify(snapshot.bom)}`,
    `mate_notes: ${JSON.stringify(snapshot.mateNotes)}`,
    '',
    '## Editable sections',
    ...formatSections(scope.editableSections, false),
    '',
    '## Read-only dependency sections',
    ...(scope.dependencySections.length > 0
      ? formatSections(scope.dependencySections, true)
      : ['(none)']),
  ];
  if (errorGuidance) {
    lines.push(
      '',
      '## Current ErrorGuidance',
      formatErrorGuidance(errorGuidance),
    );
  }
  return lines.join('\n');
}

export function buildStructuralLocalPatchWorkset({
  snapshot,
  errorGuidance,
}: {
  snapshot: ParametricModelSnapshot;
  errorGuidance?: ErrorGuidancePayload | null;
}): string {
  const lines = [
    '# Structural Local Patch Workset',
    '',
    `base_model_revision: ${snapshot.modelRevision}`,
    `artifact_kind: ${snapshot.artifactKind}`,
    'allowed_operations: add or delete complete part/component sections only',
    'part_insertion: immediately before assembly_setup',
    'component_insertion: immediately before assembly_result',
    'maximum_total_operations: 12',
    'maximum_affected_component_ids: 6',
    'never_reorder_existing_sections: true',
    'never_change_assembly_setup_or_assembly_result: true',
    '',
    '## Current component-to-Part catalog',
    `components: ${JSON.stringify(compactComponents(snapshot))}`,
    `bom: ${JSON.stringify(snapshot.bom)}`,
    '',
    '## Required patch rules',
    'Submit additions and/or deletions only; do not replace existing sections.',
    'A deleted Part must have no remaining Component that references it.',
    'List every added, deleted, or Part-affected component in affected_component_ids.',
  ];
  if (errorGuidance) {
    lines.push(
      '',
      '## Current ErrorGuidance',
      formatErrorGuidance(errorGuidance),
    );
  }
  return lines.join('\n');
}

export function buildRebuildWorkset({
  artifact,
  snapshot,
  reason,
  protectedRebuild,
  errorGuidance,
}: {
  artifact?: ParametricArtifact;
  snapshot?: ParametricModelSnapshot;
  reason: string;
  protectedRebuild?: {
    contract: ProtectedRebuildContract;
    newPartId: string;
  } | null;
  errorGuidance?: ErrorGuidancePayload | null;
}): string {
  const lines = ['# Complete Rebuild Workset', '', `reason: ${reason}`];
  if (snapshot) {
    lines.push(
      `base_model_revision: ${snapshot.modelRevision}`,
      `artifact_kind: ${snapshot.artifactKind}`,
      `model_summary: ${snapshot.modelSummary || '(not available)'}`,
      `recent_changes: ${JSON.stringify(snapshot.recentChanges)}`,
      `parameters: ${JSON.stringify(snapshot.parameters)}`,
      `components: ${JSON.stringify(compactComponents(snapshot))}`,
      `bom: ${JSON.stringify(snapshot.bom)}`,
      `mate_notes: ${JSON.stringify(snapshot.mateNotes)}`,
    );
  }
  if (protectedRebuild) {
    lines.push(
      '',
      '## Protected rebuild contract',
      `new_part_id: ${protectedRebuild.newPartId}`,
      `protected_rebuild: ${JSON.stringify(protectedRebuild.contract)}`,
      'Copy every unapproved existing source section exactly. Add and replace only the sections listed in this contract, and submit this exact contract in the tool input.',
    );
  }
  if (errorGuidance) {
    lines.push(
      '',
      '## Current ErrorGuidance',
      formatErrorGuidance(errorGuidance),
    );
  }
  if (artifact) {
    lines.push(
      '',
      '## Current complete SimpleCADAPI source',
      '```python',
      artifact.code,
      '```',
    );
  }
  return lines.join('\n');
}

function compactComponents(snapshot: ParametricModelSnapshot) {
  return snapshot.components.map((component) => ({
    component_id: component.component_id,
    component_name: component.component_name,
    part_id: component.part_id,
    part_name: component.part_name,
    placement: component.placement,
  }));
}

function formatSections(
  sections: readonly AssemblySourceSection[],
  readOnly: boolean,
): string[] {
  return sections.flatMap((section) => [
    `### ${section.kind}/${section.id}${readOnly ? ' (read only)' : ''}`,
    '```python',
    `# iriscad:${section.kind}${
      section.kind === 'parameters' ||
      section.kind === 'assembly_setup' ||
      section.kind === 'assembly_result'
        ? ''
        : ` ${section.id}`
    }`,
    section.source,
    '```',
  ]);
}

function formatErrorGuidance(guidance: ErrorGuidancePayload): string {
  return JSON.stringify({
    operation: guidance.operation,
    what_happened: guidance.what_happened,
    possible_causes: guidance.possible_causes,
    how_to_fix: guidance.how_to_fix,
    signature: guidance.signature,
    documentation_hint: guidance.documentation_hint,
    technical_details: guidance.technical_details,
  });
}

type ApiIndexEntry = {
  id: string;
  signature: string;
  summary: string;
};

const INDEX_ENTRY_RE =
  /^- `(?:api|stdlib)\/([^/`]+)\.md` — `([^`]+)`\s*(.*)$/gm;
const SCAD_CALL_RE = /\bscad\.([A-Za-z_]\w*)\s*\(/g;
const SCAD_STDLIB_CALL_RE =
  /\bscad\.std(?:\.[A-Za-z_]\w*)*\.([A-Za-z_]\w*)\s*\(/g;
const ASSEMBLY_FIXED_REFERENCE_IDS = new Set([
  'make_part_rpart',
  'make_assembly_rassembly',
  'add_component_rassembly',
  'make_placement_rplacement',
  'identity_placement_rplacement',
]);

export function extractSimpleCadApiIds(code: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const regex of [SCAD_CALL_RE, SCAD_STDLIB_CALL_RE]) {
    regex.lastIndex = 0;
    for (const match of code.matchAll(regex)) {
      const id = match[1];
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

export function buildCompactApiReference({
  apiIndex,
  rankedHitIds,
  currentCompleteCode,
  relevantSectionCode,
  maxNewApis = LOCAL_EDIT_NEW_API_LIMIT,
}: {
  apiIndex: string;
  rankedHitIds: readonly string[];
  currentCompleteCode: string;
  relevantSectionCode: string;
  maxNewApis?: number;
}): { markdown: string; existingIds: string[]; newIds: string[] } {
  const entries = parseApiIndex(apiIndex);
  const usedEverywhere = new Set(extractSimpleCadApiIds(currentCompleteCode));
  const relevantIds = extractSimpleCadApiIds(relevantSectionCode);
  const hitRank = new Map(rankedHitIds.map((id, index) => [id, index]));
  const existingIds = relevantIds
    .filter((id) => !ASSEMBLY_FIXED_REFERENCE_IDS.has(id))
    .sort((left, right) => {
      const leftRank = hitRank.get(left) ?? Number.POSITIVE_INFINITY;
      const rightRank = hitRank.get(right) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank;
    });
  const newIds = rankedHitIds
    .filter(
      (id) =>
        !ASSEMBLY_FIXED_REFERENCE_IDS.has(id) &&
        !usedEverywhere.has(id) &&
        entries.has(id),
    )
    .slice(0, maxNewApis);

  const lines = ['# APIs for this edit', ''];
  lines.push('## APIs already used by the editable code');
  if (existingIds.length === 0) {
    lines.push('(none)');
  } else {
    for (const id of existingIds) {
      lines.push(formatApiEntry(entries.get(id), id, 'current dependency'));
    }
  }
  lines.push('', `## New APIs relevant to this change (maximum ${maxNewApis})`);
  if (newIds.length === 0) {
    lines.push('(none)');
  } else {
    for (const id of newIds) {
      lines.push(formatApiEntry(entries.get(id), id, 'new retrieval hit'));
    }
  }
  return { markdown: lines.join('\n'), existingIds, newIds };
}

function parseApiIndex(index: string): Map<string, ApiIndexEntry> {
  const entries = new Map<string, ApiIndexEntry>();
  INDEX_ENTRY_RE.lastIndex = 0;
  for (const match of index.matchAll(INDEX_ENTRY_RE)) {
    entries.set(match[1], {
      id: match[1],
      signature: match[2],
      summary: match[3].trim(),
    });
  }
  return entries;
}

function formatApiEntry(
  entry: ApiIndexEntry | undefined,
  id: string,
  label: string,
): string {
  if (!entry)
    return `- \`${id}\` — ${label}; use exactly as shown in the supplied code.`;
  return `- \`${entry.signature}\` — ${label}. ${entry.summary}`;
}

export function relevantScopeCode(scope: AssemblyPatchScope): string {
  return [...scope.editableSections, ...scope.dependencySections]
    .map((section) => section.source)
    .join('\n');
}

export function patchFailureRequiresCompleteRebuild(
  output: AppTools['patch_parametric_components']['output'],
): boolean {
  if (output.status !== 'error') return false;
  const text = `${output.message}\n${output.errorGuidance?.what_happened ?? ''}`;
  return /requires? (?:a )?(?:complete|full) rebuild|adding or removing parameters|invalid stable section layout|dynamic Python references|could not restore the patch base|no successful model snapshot/i.test(
    text,
  );
}

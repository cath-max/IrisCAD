import type {
  AssemblySourceSection,
  AssemblySourceSectionKind,
} from './assemblySourceLayout.ts';

/** Stable identity shared by source layout, planner, and Worker contracts. */
export type AssemblySectionIdentity = Pick<
  AssemblySourceSection,
  'kind' | 'id'
>;

export type AssemblySectionKey = `${AssemblySourceSectionKind}/${string}`;

export function assemblySectionKey(
  section: AssemblySectionIdentity,
): AssemblySectionKey {
  return `${section.kind}/${section.id}`;
}

/** Dynamic Python constructs that forbid a safe partial execution plan. */
export type AssemblySectionUnsafeSyntax =
  | 'eval'
  | 'exec'
  | 'dynamic_import'
  | 'globals_or_locals'
  | 'ambiguous_in_place_mutation'
  | 'unknown_dynamic_reference';

/** AST-only analysis result. It never claims that code has been executed. */
export type AssemblySectionDependencyAnalysis = {
  section: AssemblySectionIdentity;
  reads: string[];
  writes: string[];
  unsafe_syntax: AssemblySectionUnsafeSyntax[];
};

export type AssemblySectionAnalysisError = {
  reason: 'layout_invalid' | 'unsupported_python';
  detail: string;
};

export type AssemblySectionAnalysisResult =
  | { ok: true; sections: AssemblySectionDependencyAnalysis[]; error: null }
  | { ok: false; sections: []; error: AssemblySectionAnalysisError };

export type AssemblySectionExecutionFallbackReason =
  | 'layout_invalid'
  | 'unsupported_python'
  | 'dependency_ambiguous'
  | 'worker_baseline_mismatch'
  | 'partial_execution_failed'
  | 'result_validation_failed';

export type AssemblySectionPartialExecutionPlan = {
  mode: 'partial';
  changed_parameter_names: string[];
  sections_to_execute: AssemblySectionIdentity[];
  affected_part_ids: string[];
  /** Worker baseline the partial request must be based on. */
  previous_successful_artifact_version: string;
  next_artifact_version: string;
};

export type AssemblySectionFullExecutionPlan = {
  mode: 'full';
  changed_parameter_names: string[];
  reason: AssemblySectionExecutionFallbackReason;
  next_artifact_version: string;
};

/** A planner may only choose one of these two explicit execution modes. */
export type AssemblySectionExecutionPlan =
  | AssemblySectionPartialExecutionPlan
  | AssemblySectionFullExecutionPlan;

export type AssemblySectionExecutionMode =
  | 'partial'
  | 'full'
  | 'partial_then_full_fallback';

/** Timings are optional until their producer exists; values are milliseconds. */
export type AssemblySectionExecutionTiming = {
  dependency_analysis_ms?: number;
  partial_python_ms?: number;
  fallback_full_run_ms?: number;
  total_python_ms?: number;
};

/** Actual Worker result; this is distinct from the planner's requested plan. */
export type AssemblySectionExecutionResult = {
  requested_plan: AssemblySectionExecutionPlan;
  execution_mode: AssemblySectionExecutionMode;
  worker_session_id: string;
  executed_sections: AssemblySectionIdentity[];
  timing: AssemblySectionExecutionTiming;
  ok: boolean;
  final_artifact_version: string | null;
  fallback_reason?: AssemblySectionExecutionFallbackReason;
};

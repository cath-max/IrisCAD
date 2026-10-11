import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assemblySectionKey,
  type AssemblySectionExecutionPlan,
  type AssemblySectionExecutionResult,
} from './assemblySectionExecution.ts';

describe('Assembly section execution contract', () => {
  it('represents a placement-only partial plan without Parts', () => {
    const plan = {
      mode: 'partial',
      changed_parameter_names: ['saddle_x_shift'],
      sections_to_execute: [
        { kind: 'parameters', id: 'parameters' },
        { kind: 'assembly_setup', id: 'assembly_setup' },
        { kind: 'component', id: 'saddle' },
        { kind: 'assembly_result', id: 'assembly_result' },
      ],
      affected_part_ids: [],
      previous_successful_artifact_version: 'v1',
      next_artifact_version: 'v2',
    } satisfies AssemblySectionExecutionPlan;
    assert.deepEqual(plan.affected_part_ids, []);
  });

  it('represents one affected Part and the mandatory Assembly tail', () => {
    const plan = {
      mode: 'partial',
      changed_parameter_names: ['spoke_radius'],
      sections_to_execute: [
        { kind: 'parameters', id: 'parameters' },
        { kind: 'helper', id: 'helpers' },
        { kind: 'part', id: 'wheel_part' },
        { kind: 'assembly_setup', id: 'assembly_setup' },
        { kind: 'component', id: 'rear_wheel' },
        { kind: 'component', id: 'front_wheel' },
        { kind: 'assembly_result', id: 'assembly_result' },
      ],
      affected_part_ids: ['wheel_part'],
      previous_successful_artifact_version: 'v1',
      next_artifact_version: 'v2',
    } satisfies AssemblySectionExecutionPlan;
    assert.equal(
      assemblySectionKey(plan.sections_to_execute[2]),
      'part/wheel_part',
    );
  });

  it('represents a multi-Part partial plan and its actual Worker result', () => {
    const plan = {
      mode: 'partial',
      changed_parameter_names: ['wheel_width', 'frame_tube_radius'],
      sections_to_execute: [
        { kind: 'parameters', id: 'parameters' },
        { kind: 'part', id: 'wheel_part' },
        { kind: 'part', id: 'main_frame_part' },
        { kind: 'assembly_setup', id: 'assembly_setup' },
        { kind: 'assembly_result', id: 'assembly_result' },
      ],
      affected_part_ids: ['wheel_part', 'main_frame_part'],
      previous_successful_artifact_version: 'v1',
      next_artifact_version: 'v2',
    } satisfies AssemblySectionExecutionPlan;
    const result = {
      requested_plan: plan,
      execution_mode: 'partial',
      worker_session_id: 'conversation-1',
      executed_sections: plan.sections_to_execute,
      timing: { dependency_analysis_ms: 3, partial_python_ms: 7000 },
      ok: true,
      final_artifact_version: 'v2',
    } satisfies AssemblySectionExecutionResult;
    assert.equal(result.executed_sections.length, 5);
  });

  it('represents a complete fallback without pretending snippets ran', () => {
    const plan = {
      mode: 'full',
      changed_parameter_names: ['saddle_x_shift'],
      reason: 'dependency_ambiguous',
      next_artifact_version: 'v2',
    } satisfies AssemblySectionExecutionPlan;
    const result = {
      requested_plan: plan,
      execution_mode: 'full',
      worker_session_id: 'conversation-1',
      executed_sections: [],
      timing: { fallback_full_run_ms: 23000, total_python_ms: 23000 },
      ok: true,
      final_artifact_version: 'v2',
      fallback_reason: 'dependency_ambiguous',
    } satisfies AssemblySectionExecutionResult;
    assert.equal(result.execution_mode, 'full');
  });
});

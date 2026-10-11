import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  planAssemblySectionExecution,
  type AssemblySectionChange,
  type AssemblySectionExecutionPlanningInput,
} from './assemblySectionExecutionPlanner.ts';
import type {
  AssemblySectionDependencyAnalysis,
  AssemblySectionKey,
} from './assemblySectionExecution.ts';

const source = `import simplecadapi as scad
# iriscad:parameters
saddle_x_shift = 0.0
spoke_radius = 2.0
frame_tube_radius = 12.0
unused_value = 1.0
# iriscad:helper wheel_helpers
wheel_profile = spoke_radius * 2
# iriscad:part wheel_part
wheel_part = scad.make(wheel_profile)
# iriscad:part frame_part
frame_part = scad.make(frame_tube_radius)
# iriscad:assembly_setup
assembly = scad.assembly()
# iriscad:component rear_wheel
assembly = scad.add(assembly, wheel_part)
# iriscad:component front_wheel
assembly = scad.add(assembly, wheel_part)
# iriscad:component saddle
assembly = scad.add(assembly, frame_part, saddle_x_shift)
# iriscad:assembly_result
result = assembly`;

const analysis: AssemblySectionDependencyAnalysis[] = [
  section(
    'parameters',
    'parameters',
    [],
    ['saddle_x_shift', 'spoke_radius', 'frame_tube_radius', 'unused_value'],
  ),
  section('helper', 'wheel_helpers', ['spoke_radius'], ['wheel_profile']),
  section('part', 'wheel_part', ['wheel_profile'], ['wheel_part']),
  section('part', 'frame_part', ['frame_tube_radius'], ['frame_part']),
  section('assembly_setup', 'assembly_setup', [], ['assembly']),
  section('component', 'rear_wheel', ['assembly', 'wheel_part'], ['assembly']),
  section('component', 'front_wheel', ['assembly', 'wheel_part'], ['assembly']),
  section(
    'component',
    'saddle',
    ['assembly', 'frame_part', 'saddle_x_shift'],
    ['assembly'],
  ),
  section('assembly_result', 'assembly_result', ['assembly'], ['result']),
];

function section(
  kind: AssemblySectionDependencyAnalysis['section']['kind'],
  id: string,
  reads: string[],
  writes: string[],
): AssemblySectionDependencyAnalysis {
  return { section: { kind, id }, reads, writes, unsafe_syntax: [] };
}

function plan(
  parameterNames: string[],
  nextAnalysis = analysis,
  nextSource = source,
) {
  return planAssemblySectionExecution({
    next_source: nextSource,
    analysis: { ok: true, sections: nextAnalysis, error: null },
    previous_successful_artifact_version: 'v1',
    next_artifact_version: 'v2',
    change: { kind: 'parameters', parameter_names: parameterNames },
  } satisfies AssemblySectionExecutionPlanningInput);
}

function planFromSections(
  sectionKeys: AssemblySectionKey[],
  nextAnalysis = analysis,
  nextSource = source,
) {
  return planFromSectionChanges(
    sectionKeys.map((sectionKey) => ({ operation: 'replace', sectionKey })),
    nextAnalysis,
    nextSource,
  );
}

function planFromSectionChanges(
  sectionChanges: AssemblySectionChange[],
  nextAnalysis = analysis,
  nextSource = source,
) {
  return planAssemblySectionExecution({
    next_source: nextSource,
    analysis: { ok: true, sections: nextAnalysis, error: null },
    previous_successful_artifact_version: 'v1',
    next_artifact_version: 'v2',
    change: {
      kind: 'sections',
      section_changes: sectionChanges,
    },
  } satisfies AssemblySectionExecutionPlanningInput);
}

describe('Assembly section execution planner', () => {
  it('plans a placement-only edit as parameters plus the complete Assembly tail', () => {
    const result = plan(['saddle_x_shift']);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, []);
    assert.deepEqual(
      result.sections_to_execute.map((item) => `${item.kind}/${item.id}`),
      [
        'parameters/parameters',
        'assembly_setup/assembly_setup',
        'component/rear_wheel',
        'component/front_wheel',
        'component/saddle',
        'assembly_result/assembly_result',
      ],
    );
  });

  it('plans one shared Part once, then rebuilds every Component', () => {
    const result = plan(['spoke_radius']);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, ['wheel_part']);
    assert.deepEqual(
      result.sections_to_execute.map((item) => `${item.kind}/${item.id}`),
      [
        'parameters/parameters',
        'helper/wheel_helpers',
        'part/wheel_part',
        'assembly_setup/assembly_setup',
        'component/rear_wheel',
        'component/front_wheel',
        'component/saddle',
        'assembly_result/assembly_result',
      ],
    );
  });

  it('uses a changed Part section as a direct dirty-Part seed', () => {
    const result = planFromSections(['part/wheel_part']);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, ['wheel_part']);
    assert.deepEqual(
      result.sections_to_execute.map((item) => `${item.kind}/${item.id}`),
      [
        'part/wheel_part',
        'assembly_setup/assembly_setup',
        'component/rear_wheel',
        'component/front_wheel',
        'component/saddle',
        'assembly_result/assembly_result',
      ],
    );
  });

  it('uses a changed Component section as an Assembly-only seed', () => {
    const result = planFromSections(['component/saddle']);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, []);
    assert.deepEqual(
      result.sections_to_execute.map((item) => `${item.kind}/${item.id}`),
      [
        'assembly_setup/assembly_setup',
        'component/rear_wheel',
        'component/front_wheel',
        'component/saddle',
        'assembly_result/assembly_result',
      ],
    );
  });

  it('executes an added Part then the complete new Assembly tail', () => {
    const nextSource = source
      .replace(
        '# iriscad:assembly_setup',
        '# iriscad:part cap_part\ncap_part = scad.make()\n# iriscad:assembly_setup',
      )
      .replace(
        '# iriscad:assembly_result',
        '# iriscad:component cap\nassembly = scad.add(assembly, cap_part)\n# iriscad:assembly_result',
      );
    const nextAnalysis = [
      ...analysis.slice(0, 4),
      section('part', 'cap_part', [], ['cap_part']),
      ...analysis.slice(4, 8),
      section('component', 'cap', ['assembly', 'cap_part'], ['assembly']),
      analysis[8],
    ];
    const result = planFromSectionChanges(
      [
        { operation: 'add', sectionKey: 'part/cap_part' },
        { operation: 'add', sectionKey: 'component/cap' },
      ],
      nextAnalysis,
      nextSource,
    );
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, ['cap_part']);
    assert.deepEqual(
      result.sections_to_execute.map((item) => `${item.kind}/${item.id}`),
      [
        'part/cap_part',
        'assembly_setup/assembly_setup',
        'component/rear_wheel',
        'component/front_wheel',
        'component/saddle',
        'component/cap',
        'assembly_result/assembly_result',
      ],
    );
  });

  it('rebuilds only the Assembly tail for an added reused-Part Component', () => {
    const nextSource = source.replace(
      '# iriscad:assembly_result',
      '# iriscad:component spare_wheel\nassembly = scad.add(assembly, wheel_part)\n# iriscad:assembly_result',
    );
    const nextAnalysis = [
      ...analysis.slice(0, 8),
      section(
        'component',
        'spare_wheel',
        ['assembly', 'wheel_part'],
        ['assembly'],
      ),
      analysis[8],
    ];
    const result = planFromSectionChanges(
      [{ operation: 'add', sectionKey: 'component/spare_wheel' }],
      nextAnalysis,
      nextSource,
    );
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, []);
    assert.equal(
      result.sections_to_execute.some((section) => section.kind === 'part'),
      false,
    );
  });

  it('does not execute deleted sections but rebuilds the remaining Assembly tail', () => {
    const nextSource = source
      .replace(
        '# iriscad:part frame_part\nframe_part = scad.make(frame_tube_radius)\n',
        '',
      )
      .replace(
        '# iriscad:component saddle\nassembly = scad.add(assembly, frame_part, saddle_x_shift)\n',
        '',
      );
    const nextAnalysis = analysis.filter(
      (entry) =>
        entry.section.id !== 'frame_part' && entry.section.id !== 'saddle',
    );
    const result = planFromSectionChanges(
      [
        { operation: 'delete', sectionKey: 'part/frame_part' },
        { operation: 'delete', sectionKey: 'component/saddle' },
      ],
      nextAnalysis,
      nextSource,
    );
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, []);
    assert.deepEqual(
      result.sections_to_execute.map((item) => `${item.kind}/${item.id}`),
      [
        'assembly_setup/assembly_setup',
        'component/rear_wheel',
        'component/front_wheel',
        'assembly_result/assembly_result',
      ],
    );
  });

  it('plans every independently affected Part in original source order', () => {
    const result = plan(['spoke_radius', 'frame_tube_radius']);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, ['wheel_part', 'frame_part']);
  });

  it('permits a parameter with no geometry consumer without rebuilding the Assembly', () => {
    const result = plan(['unused_value']);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.sections_to_execute, [
      { kind: 'parameters', id: 'parameters' },
    ]);
  });

  it('allows an unchanged unrelated container mutation to remain in the verified baseline', () => {
    const withUnrelatedMutation = analysis.map((item) =>
      item.section.id === 'frame_part'
        ? { ...item, unsafe_syntax: ['ambiguous_in_place_mutation' as const] }
        : item,
    );
    const result = plan(['spoke_radius'], withUnrelatedMutation);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, ['wheel_part']);
  });

  it('falls back when a selected section contains a container mutation', () => {
    const withSelectedMutation = analysis.map((item) =>
      item.section.id === 'wheel_part'
        ? { ...item, unsafe_syntax: ['ambiguous_in_place_mutation' as const] }
        : item,
    );
    const result = plan(['spoke_radius'], withSelectedMutation);
    assert.deepEqual(
      {
        mode: result.mode,
        reason: result.mode === 'full' ? result.reason : undefined,
      },
      {
        mode: 'full',
        reason: 'unsupported_python',
      },
    );
  });

  it('still falls back globally for a truly dynamic dependency', () => {
    const withDynamicHelper = analysis.map((item) =>
      item.section.id === 'wheel_helpers'
        ? { ...item, unsafe_syntax: ['globals_or_locals' as const] }
        : item,
    );
    const result = plan(['unused_value'], withDynamicHelper);
    assert.deepEqual(
      {
        mode: result.mode,
        reason: result.mode === 'full' ? result.reason : undefined,
      },
      {
        mode: 'full',
        reason: 'unsupported_python',
      },
    );
  });

  it('falls back when a helper/Part dependency cycle is present', () => {
    const cyclic = analysis.map((item) =>
      item.section.id === 'wheel_helpers'
        ? { ...item, reads: ['spoke_radius', 'wheel_part'] }
        : item,
    );
    const result = plan(['spoke_radius'], cyclic);
    assert.deepEqual(
      {
        mode: result.mode,
        reason: result.mode === 'full' ? result.reason : undefined,
      },
      {
        mode: 'full',
        reason: 'dependency_ambiguous',
      },
    );
  });

  it('does not let an unrelated helper/Part cycle block a selected dependency closure', () => {
    const unrelatedCycle = analysis.map((item) => {
      if (item.section.id === 'frame_part') {
        return { ...item, reads: ['frame_tube_radius', 'wheel_part'] };
      }
      if (item.section.id === 'wheel_part') {
        return { ...item, reads: ['wheel_profile', 'frame_part'] };
      }
      return item;
    });
    const result = plan(['unused_value'], unrelatedCycle);
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, []);
  });

  it('does not mistake helper calls within one section for a cross-section cycle', () => {
    const selfContainedHelpers = analysis.map((item) =>
      item.section.id === 'wheel_helpers'
        ? { ...item, reads: ['spoke_radius', 'wheel_helpers'] }
        : item,
    );
    const result = plan(['spoke_radius'], selfContainedHelpers);
    assert.equal(result.mode, 'partial');
  });

  it('uses explicit parameter names without comparing unrelated source text', () => {
    const result = plan(
      ['spoke_radius'],
      analysis,
      source.replace(
        'wheel_profile = spoke_radius * 2',
        'wheel_profile = spoke_radius * 3',
      ),
    );
    assert.equal(result.mode, 'partial');
    if (result.mode !== 'partial') return;
    assert.deepEqual(result.affected_part_ids, ['wheel_part']);
  });
});

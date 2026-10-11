import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssemblyPatchScope } from '@shared/assemblyPatchScope';
import type { ParametricModelSnapshot } from '@shared/modelSnapshot';
import {
  buildCompactApiReference,
  buildLocalPatchWorkset,
  buildProtectedRebuildContract,
  buildRebuildWorkset,
  buildStructuralLocalPatchWorkset,
  extractSimpleCadApiIds,
  normalizeRouteDecision,
  patchFailureRequiresCompleteRebuild,
} from './localEditContext.ts';

const snapshot: ParametricModelSnapshot = {
  modelRevision: 'message-1:tool-1',
  artifactVersion: 'v1',
  source: { messageId: 'message-1', toolCallId: 'tool-1' },
  artifactKind: 'assembly',
  parameters: [
    {
      name: 'gear_thickness',
      displayName: 'Gear Thickness',
      value: 8,
      defaultValue: 8,
    },
  ],
  components: [
    {
      component_id: 'gear_left',
      component_name: 'Left Gear',
      item_kind: 'part',
      part_id: 'gear_part',
      part_name: 'Gear',
      placement: {
        origin: [-20, 0, 30],
        x_axis: [1, 0, 0],
        y_axis: [0, 1, 0],
        z_axis: [0, 0, 1],
      },
    },
    {
      component_id: 'gear_right',
      component_name: 'Right Gear',
      item_kind: 'part',
      part_id: 'gear_part',
      part_name: 'Gear',
      placement: {
        origin: [20, 0, 30],
        x_axis: [1, 0, 0],
        y_axis: [0, 1, 0],
        z_axis: [0, 0, 1],
      },
    },
  ],
  bom: [{ part_id: 'gear_part', part_name: 'Gear', quantity: 2 }],
  mateNotes: [],
  recentChanges: ['Moved the gears forward.'],
  modelSummary: 'Two reusable gears in one Assembly.',
  savedAt: '2026-08-19T00:00:00.000Z',
};

describe('local edit routing normalization', () => {
  it('turns a low-confidence route into a clarification', () => {
    const decision = normalizeRouteDecision(
      {
        mode: 'local',
        target_type: 'part_geometry',
        target_id: 'gear_part',
        confidence: 'medium',
        reason: 'Two gear interpretations remain.',
        clarification_question: 'Should both gears change?',
      },
      snapshot,
    );
    assert.equal(decision.mode, 'clarify');
    if (decision.mode === 'clarify') {
      assert.equal(decision.question, 'Should both gears change?');
    }
  });

  it('keeps one-instance shared-Part geometry as a protected rebuild', () => {
    const decision = normalizeRouteDecision(
      {
        mode: 'protected_rebuild',
        target_type: 'component_geometry',
        target_id: 'gear_left',
        confidence: 'high',
        reason: 'Only the left reused instance should change.',
        clarification_question: null,
      },
      snapshot,
    );
    assert.deepEqual(decision, {
      mode: 'protected_rebuild',
      componentId: 'gear_left',
      reason: 'Only the left reused instance should change.',
    });
    const protectedRebuild = buildProtectedRebuildContract(
      snapshot,
      'gear_left',
    );
    assert.ok(protectedRebuild);
    assert.deepEqual(protectedRebuild.contract.affected_component_ids, [
      'gear_left',
    ]);
    assert.deepEqual(protectedRebuild.contract.replace_sections, [
      { section_kind: 'component', section_id: 'gear_left' },
    ]);
    assert.equal(
      protectedRebuild.contract.add_sections[0].section_kind,
      'part',
    );
  });

  it('normalizes an existing helper implementation as a local target', () => {
    assert.deepEqual(
      normalizeRouteDecision(
        {
          mode: 'local',
          target_type: 'helper_implementation',
          target_id: 'make_pedal',
          confidence: 'high',
          reason: 'Both pedals use this helper.',
          clarification_question: null,
        },
        snapshot,
      ),
      {
        mode: 'local',
        target: {
          kind: 'helper',
          helperId: 'make_pedal',
          change: 'implementation',
        },
        reason: 'Both pedals use this helper.',
      },
    );
  });

  it('routes a clear Part or Component addition/removal to the structural patch path', () => {
    assert.deepEqual(
      normalizeRouteDecision(
        {
          mode: 'local',
          target_type: 'part_or_component_add_remove',
          target_id: null,
          confidence: 'high',
          reason: 'Add one clearly named accessory component.',
          clarification_question: null,
        },
        snapshot,
      ),
      {
        mode: 'local_structure',
        reason: 'Add one clearly named accessory component.',
      },
    );
  });
});

describe('local edit worksets and API references', () => {
  const partSection = {
    kind: 'part' as const,
    id: 'gear_part',
    startLine: 4,
    endLine: 8,
    source:
      'gear_solid = scad.make_box_rsolid(20, 5, gear_thickness)\ngear_part = scad.make_part_rpart("gear_part", gear_solid)',
  };
  const parameterSection = {
    kind: 'parameters' as const,
    id: 'parameters',
    startLine: 2,
    endLine: 3,
    source: 'gear_thickness = 8.0',
  };
  const scope: AssemblyPatchScope = {
    target: { kind: 'part', partId: 'gear_part', change: 'geometry' },
    editableSections: [partSection],
    dependencySections: [parameterSection],
    affectedComponentIds: ['gear_left', 'gear_right'],
  };

  it('sends editable source, read-only dependencies, snapshot and revision', () => {
    const workset = buildLocalPatchWorkset({ snapshot, scope });
    assert.match(workset, /base_model_revision: message-1:tool-1/);
    assert.match(workset, /part\/gear_part/);
    assert.match(workset, /parameters\/parameters \(read only\)/);
    assert.match(workset, /gear_left/);
    assert.doesNotMatch(workset, /Current complete SimpleCADAPI source/);
  });

  it('includes complete source only in a rebuild workset', () => {
    const workset = buildRebuildWorkset({
      artifact: {
        title: 'Gears',
        version: 'v1',
        artifact_kind: 'assembly',
        code: 'import simplecadapi as scad\nresult = assembly',
        model_summary: 'Two gears.',
      },
      snapshot,
      reason: 'Assembly structure changes.',
    });
    assert.match(workset, /Current complete SimpleCADAPI source/);
    assert.match(workset, /result = assembly/);
  });

  it('gives structural patches the insertion and component-to-Part rules without source', () => {
    const workset = buildStructuralLocalPatchWorkset({ snapshot });
    assert.match(workset, /part_insertion: immediately before assembly_setup/);
    assert.match(
      workset,
      /component_insertion: immediately before assembly_result/,
    );
    assert.match(workset, /maximum_affected_component_ids: 6/);
    assert.match(workset, /gear_left/);
    assert.doesNotMatch(workset, /Current complete SimpleCADAPI source/);
  });

  it('keeps score order and admits at most five APIs unused by current source', () => {
    const apiIndex = [
      '# index',
      '- `api/make_box_rsolid.md` — `make_box_rsolid(length: float) -> Solid` makes a box.',
      '- `api/cut_rsolid.md` — `cut_rsolid(base: Solid, tool: Solid) -> Solid` cuts a solid.',
      '- `api/loft_rsolid.md` — `loft_rsolid(*wires: Wire) -> Solid` lofts sections.',
      '- `api/fillet_rsolid.md` — `fillet_rsolid(solid: Solid) -> Solid` rounds edges.',
      '- `api/extrude_rsolid.md` — `extrude_rsolid(face: Face) -> Solid` extrudes a face.',
      '- `api/sweep_rsolid.md` — `sweep_rsolid(profile: Wire) -> Solid` sweeps a profile.',
      '- `api/make_sphere_rsolid.md` — `make_sphere_rsolid(radius: float) -> Solid` makes a sphere.',
    ].join('\n');
    const result = buildCompactApiReference({
      apiIndex,
      rankedHitIds: [
        'loft_rsolid',
        'make_box_rsolid',
        'cut_rsolid',
        'fillet_rsolid',
        'extrude_rsolid',
        'sweep_rsolid',
        'make_sphere_rsolid',
      ],
      currentCompleteCode:
        'a = scad.make_box_rsolid(1)\nb = scad.cut_rsolid(a, tool)',
      relevantSectionCode: 'a = scad.make_box_rsolid(1)',
    });
    assert.deepEqual(result.existingIds, ['make_box_rsolid']);
    assert.deepEqual(result.newIds, [
      'loft_rsolid',
      'fillet_rsolid',
      'extrude_rsolid',
      'sweep_rsolid',
      'make_sphere_rsolid',
    ]);
    assert.ok(!result.newIds.includes('cut_rsolid'));
    assert.ok(
      result.markdown.indexOf('loft_rsolid') <
        result.markdown.indexOf('fillet_rsolid'),
    );
  });

  it('extracts direct and stdlib SimpleCADAPI calls without duplicates', () => {
    assert.deepEqual(
      extractSimpleCadApiIds(
        'scad.make_box_rsolid(1, 2, 3)\nscad.std.gear.make_spur_gear_rsolid(24, 2)\nscad.make_box_rsolid(4, 5, 6)',
      ),
      ['make_box_rsolid', 'make_spur_gear_rsolid'],
    );
  });
});

describe('local patch fallback', () => {
  it('recognizes a deterministic complete-rebuild rejection', () => {
    assert.equal(
      patchFailureRequiresCompleteRebuild({
        status: 'error',
        message: 'Adding or removing parameters requires a complete rebuild.',
        errorGuidance: null,
      }),
      true,
    );
  });
});

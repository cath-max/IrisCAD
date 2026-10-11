import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeAssemblyPatchScope,
  assemblyPatchTargetCatalog,
} from './assemblyPatchScope.ts';
import type { ParametricModelSnapshot } from './modelSnapshot.ts';

const code = `import simplecadapi as scad
# iriscad:parameters
gear_thickness = 8.0
base_length = 100.0
# iriscad:helper shared_math
def half(value):
    return value / 2.0
# iriscad:part base_part
base_solid = scad.make_box_rsolid(base_length, 20.0, 5.0)
base_part = scad.make_part_rpart("base_part", base_solid)
# iriscad:part gear_part
gear_solid = scad.make_cylinder_rsolid(half(gear_thickness), gear_thickness)
gear_part = scad.make_part_rpart("gear_part", gear_solid)
# iriscad:assembly_setup
assembly = scad.make_assembly_rassembly("demo")
# iriscad:component base_plate
assembly = scad.add_component_rassembly(assembly, base_part, "base_plate", scad.identity_placement_rplacement())
# iriscad:component gear_left
assembly = scad.add_component_rassembly(assembly, gear_part, "gear_left", scad.identity_placement_rplacement())
# iriscad:component gear_right
assembly = scad.add_component_rassembly(assembly, gear_part, "gear_right", scad.identity_placement_rplacement())
# iriscad:assembly_result
result = assembly`;

const snapshot: ParametricModelSnapshot = {
  modelRevision: 'message:call',
  artifactVersion: 'v1',
  source: { messageId: 'message', toolCallId: 'call' },
  artifactKind: 'assembly',
  parameters: [
    {
      name: 'gear_thickness',
      displayName: 'Gear Thickness',
      value: 8,
      defaultValue: 8,
    },
    {
      name: 'base_length',
      displayName: 'Base Length',
      value: 100,
      defaultValue: 100,
    },
  ],
  components: [
    {
      component_id: 'base_plate',
      component_name: 'Base Plate',
      item_kind: 'part',
      part_id: 'base_part',
      part_name: 'Base',
      placement: {
        origin: [0, 0, 0],
        x_axis: [1, 0, 0],
        y_axis: [0, 1, 0],
        z_axis: [0, 0, 1],
      },
    },
    {
      component_id: 'gear_left',
      component_name: 'Left Gear',
      item_kind: 'part',
      part_id: 'gear_part',
      part_name: 'Gear',
      placement: {
        origin: [0, 0, 0],
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
        origin: [0, 0, 0],
        x_axis: [1, 0, 0],
        y_axis: [0, 1, 0],
        z_axis: [0, 0, 1],
      },
    },
  ],
  bom: [],
  mateNotes: [],
  recentChanges: [],
  modelSummary: 'Demo assembly.',
  savedAt: '2026-08-19T00:00:00.000Z',
};

describe('Assembly patch scope', () => {
  it('limits a Placement edit to its named component', () => {
    const result = analyzeAssemblyPatchScope({
      code,
      snapshot,
      target: {
        kind: 'component',
        componentId: 'gear_left',
        change: 'placement',
      },
    });
    assert.equal(result.mode, 'local');
    if (result.mode !== 'local') return;
    assert.deepEqual(result.scope.affectedComponentIds, ['gear_left']);
    assert.deepEqual(
      result.scope.editableSections.map(
        (section) => `${section.kind}/${section.id}`,
      ),
      ['component/gear_left'],
    );
  });

  it('counts every component that reuses an edited Part', () => {
    const result = analyzeAssemblyPatchScope({
      code,
      snapshot,
      target: { kind: 'part', partId: 'gear_part', change: 'geometry' },
    });
    assert.equal(result.mode, 'local');
    if (result.mode !== 'local') return;
    assert.deepEqual(result.scope.affectedComponentIds, [
      'gear_left',
      'gear_right',
    ]);
  });

  it('makes a helper editable and traces the Parts that call it', () => {
    const result = analyzeAssemblyPatchScope({
      code,
      snapshot,
      target: {
        kind: 'helper',
        helperId: 'shared_math',
        change: 'implementation',
      },
    });
    assert.equal(result.mode, 'local');
    if (result.mode !== 'local') return;
    assert.deepEqual(result.scope.affectedComponentIds, [
      'gear_left',
      'gear_right',
    ]);
    assert.deepEqual(
      result.scope.editableSections.map(
        (section) => `${section.kind}/${section.id}`,
      ),
      ['helper/shared_math'],
    );
  });

  it('tracks parameter consumers as a local scope when impact stays bounded', () => {
    const result = analyzeAssemblyPatchScope({
      code,
      snapshot,
      target: {
        kind: 'parameter',
        parameterName: 'gear_thickness',
        change: 'value',
      },
    });
    assert.equal(result.mode, 'local');
    if (result.mode !== 'local') return;
    assert.deepEqual(result.scope.affectedComponentIds, [
      'gear_left',
      'gear_right',
    ]);
    assert.deepEqual(
      result.scope.editableSections.map(
        (section) => `${section.kind}/${section.id}`,
      ),
      ['parameters/parameters'],
    );
    assert.equal(
      result.scope.dependencySections.some(
        (section) => section.kind === 'part' && section.id === 'gear_part',
      ),
      true,
    );
  });

  it('falls back when a parameter affects more than the component limit', () => {
    const result = analyzeAssemblyPatchScope({
      code,
      snapshot,
      target: {
        kind: 'parameter',
        parameterName: 'gear_thickness',
        change: 'value',
      },
      componentLimit: 1,
    });
    assert.equal(result.mode, 'rebuild');
  });

  it('asks for clarification when the chosen current component does not exist', () => {
    const result = analyzeAssemblyPatchScope({
      code,
      snapshot,
      target: {
        kind: 'component',
        componentId: 'unknown',
        change: 'placement',
      },
    });
    assert.equal(result.mode, 'clarify');
  });

  it('provides names and IDs for future LLM target selection', () => {
    assert.deepEqual(assemblyPatchTargetCatalog(snapshot).components[1], {
      componentId: 'gear_left',
      componentName: 'Left Gear',
      partId: 'gear_part',
      partName: 'Gear',
    });
    assert.deepEqual(assemblyPatchTargetCatalog(snapshot, code).helpers, [
      'shared_math',
    ]);
  });
});

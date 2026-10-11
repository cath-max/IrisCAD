import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateV1AssemblyStructure,
  validateV1MateNotes,
  type AssemblyStructure,
} from './assemblyContract.ts';

const placement = {
  origin: [0, 0, 0] as [number, number, number],
  x_axis: [1, 0, 0] as [number, number, number],
  y_axis: [0, 1, 0] as [number, number, number],
  z_axis: [0, 0, 1] as [number, number, number],
};

const validStructure: AssemblyStructure = {
  assembly_id: 'fixture',
  name: 'Fixture',
  components: [
    {
      component_id: 'bolt_left',
      component_name: 'Left bolt',
      item_kind: 'part',
      part_id: 'bolt',
      part_name: 'Bolt',
      placement,
    },
    {
      component_id: 'bolt_right',
      component_name: 'Right bolt',
      item_kind: 'part',
      part_id: 'bolt',
      part_name: 'Bolt',
      placement: { ...placement, origin: [10, 0, 0] },
    },
  ],
  bom: [{ part_id: 'bolt', part_name: 'Bolt', quantity: 2 }],
};

describe('V1 Assembly structure contract', () => {
  it('accepts direct Part instances that reuse one part_id', () => {
    assert.deepEqual(validateV1AssemblyStructure(validStructure), []);
  });

  it('rejects an empty assembly and a nested assembly', () => {
    assert.deepEqual(
      validateV1AssemblyStructure({ ...validStructure, components: [] }),
      ['Assembly must contain at least one Part component.'],
    );
    assert.match(
      validateV1AssemblyStructure({
        ...validStructure,
        components: [
          {
            ...validStructure.components[0],
            item_kind: 'assembly',
            part_id: null,
          },
        ],
      }).join('\n'),
      /subassembly/,
    );
  });

  it('rejects duplicate IDs and missing required instance metadata', () => {
    const violations = validateV1AssemblyStructure({
      ...validStructure,
      components: [
        validStructure.components[0],
        {
          ...validStructure.components[0],
          component_name: null,
          part_id: null,
          placement: {} as typeof placement,
        },
      ],
    });
    assert.match(violations.join('\n'), /Duplicate component_id/);
    assert.match(violations.join('\n'), /missing part_id/);
    assert.match(violations.join('\n'), /missing a name/);
    assert.match(violations.join('\n'), /invalid Placement/);
  });

  it('accepts pairwise notes for real components without solving them', () => {
    assert.deepEqual(
      validateV1MateNotes(
        [
          {
            note_id: 'bolt_axis',
            kind: 'coaxial',
            component_ids: ['bolt_left', 'bolt_right'],
            description: 'The two bolts share the same intended axis.',
          },
          {
            note_id: 'bolt_offset',
            kind: 'offset',
            component_ids: ['bolt_left', 'bolt_right'],
            description: 'Keep the bolt centers 10 mm apart.',
            intended_offset_mm: 10,
          },
        ],
        new Set(
          validStructure.components.map((component) => component.component_id),
        ),
      ),
      [],
    );
  });

  it('rejects duplicate note IDs, self-references, and missing components', () => {
    const violations = validateV1MateNotes(
      [
        {
          note_id: 'bad_note',
          kind: 'face_contact',
          component_ids: ['bolt_left', 'bolt_left'],
          description: 'Invalid self reference.',
        },
        {
          note_id: 'bad_note',
          kind: 'offset',
          component_ids: ['bolt_left', 'missing_component'],
          description: 'Invalid missing component.',
        },
      ],
      new Set(
        validStructure.components.map((component) => component.component_id),
      ),
    );
    assert.match(violations.join('\n'), /Duplicate mate_note note_id/);
    assert.match(violations.join('\n'), /cannot reference one component twice/);
    assert.match(violations.join('\n'), /missing component_id/);
  });
});

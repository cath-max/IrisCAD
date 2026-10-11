import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import parseParameters from './parseParameters.ts';

describe('parseParameters Python', () => {
  const mug = `import simplecadapi as scad

# Outer cup height
cup_height = 100.0  # [50:200]
cup_radius = 40.0  # [20:80]
wall_thickness = 3.0  # [1:0.5:10]
handle_center_x = cup_radius - 5.0
handle_center_z = cup_height / 2.0
enabled = True
label = "mug"

def helper():
    ignored = 1.0

result = scad.make_box_rsolid(1, 2, 3)
`;

  it('exposes top-level literals with ranges and skips expressions', () => {
    const params = parseParameters(mug);
    const names = params.map((p) => p.name).sort();
    assert.deepEqual(names, [
      'cup_height',
      'cup_radius',
      'enabled',
      'label',
      'wall_thickness',
    ]);

    const height = params.find((p) => p.name === 'cup_height');
    assert.ok(height);
    assert.equal(height.value, 100);
    assert.equal(height.description, 'Outer cup height');
    assert.deepEqual(height.range, { min: 50, max: 200 });

    const wall = params.find((p) => p.name === 'wall_thickness');
    assert.ok(wall);
    assert.deepEqual(wall.range, { min: 1, max: 10, step: 0.5 });

    const enabled = params.find((p) => p.name === 'enabled');
    assert.ok(enabled);
    assert.equal(enabled.type, 'boolean');
    assert.equal(enabled.value, true);

    const label = params.find((p) => p.name === 'label');
    assert.ok(label);
    assert.equal(label.type, 'string');
    assert.equal(label.value, 'mug');
  });

  it('does not expose assignments below def/class', () => {
    const params = parseParameters(mug);
    assert.equal(
      params.some((p) => p.name === 'ignored'),
      false,
    );
  });

  it('parses range inside a longer comment', () => {
    const params = parseParameters(
      'import simplecadapi as scad\nthick = 4.0  # mm wall [2:12]\n',
    );
    assert.equal(params.length, 1);
    assert.deepEqual(params[0].range, { min: 2, max: 12 });
  });
});

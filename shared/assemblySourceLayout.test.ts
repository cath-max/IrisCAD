import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASSEMBLY_SOURCE_LAYOUT_GUIDANCE,
  validateAssemblySourceLayout,
} from './assemblySourceLayout.ts';

const validAssemblySource = `import simplecadapi as scad

# iriscad:parameters
width = 20.0

# iriscad:helper dimensions
half_width = width / 2.0

# iriscad:part base_plate
base_solid = scad.make_box_rsolid(width, width, 4.0)
base_part = scad.make_part_rpart("base_plate", base_solid, name="Base plate")

# iriscad:assembly_setup
assembly = scad.make_assembly_rassembly("fixture", name="Fixture")

# iriscad:component base_instance
assembly = scad.add_component_rassembly(assembly, base_part, "base_instance", scad.identity_placement_rplacement(), name="Base plate")

# iriscad:assembly_result
result = assembly
`;

describe('Assembly source layout', () => {
  it('accepts a complete ordered Assembly layout', () => {
    const result = validateAssemblySourceLayout(validAssemblySource);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.layout.sections.map((section) => `${section.kind}/${section.id}`),
      [
        'parameters/parameters',
        'helper/dimensions',
        'part/base_plate',
        'assembly_setup/assembly_setup',
        'component/base_instance',
        'assembly_result/assembly_result',
      ],
    );
  });

  it('rejects unmarked executable code and missing required sections', () => {
    const result = validateAssemblySourceLayout(
      'import simplecadapi as scad\nwidth = 20\nheight = 10\n# note\ndepth = 5\n',
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    const executableIssues = result.issues.filter((issue) =>
      issue.includes('executable code'),
    );
    assert.deepEqual(executableIssues, [
      'Lines 2-3, 5: executable code must be inside an IrisCAD Assembly section.',
    ]);
    assert.match(result.issues.join('\n'), /parameters/);
    assert.match(result.issues.join('\n'), /assembly_result/);
  });

  it('exposes concise exact marker guidance for rebuild prompts and errors', () => {
    assert.match(ASSEMBLY_SOURCE_LAYOUT_GUIDANCE, /# iriscad:part base_part/);
    assert.match(ASSEMBLY_SOURCE_LAYOUT_GUIDANCE, /next IrisCAD marker or EOF/);
    assert.match(
      ASSEMBLY_SOURCE_LAYOUT_GUIDANCE,
      /matching `\[a-z\]\[a-z0-9_\]\*`/,
    );
    assert.match(
      ASSEMBLY_SOURCE_LAYOUT_GUIDANCE,
      /one or more part\/<part_id> sections, exactly one per Part/,
    );
    assert.match(
      ASSEMBLY_SOURCE_LAYOUT_GUIDANCE,
      /one or more component\/<component_id> sections, exactly one per component/,
    );
    assert.match(ASSEMBLY_SOURCE_LAYOUT_GUIDANCE, /`add_component_rassembly`/);
    assert.match(
      ASSEMBLY_SOURCE_LAYOUT_GUIDANCE,
      /each helper section must contain exactly one top-level `def`/,
    );
  });

  it('rejects duplicate, nested, and out-of-order sections', () => {
    const source = validAssemblySource
      .replace(
        '# iriscad:part base_plate',
        '# iriscad:part base_plate\n# iriscad:helper late_helper',
      )
      .replace(
        '# iriscad:component base_instance',
        '# iriscad:part base_plate\n# iriscad:component base_instance',
      );
    const result = validateAssemblySourceLayout(source);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const issues = result.issues.join('\n');
    assert.match(issues, /sections must appear after/);
    assert.match(issues, /Duplicate Assembly section/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeParametricComponentPatch,
  resolveParametricArtifactRevision,
  validateProtectedRebuildRuntime,
  validateProtectedRebuildSource,
} from './parametricSourceHistory.ts';
import type { ParametricModelSnapshot } from './modelSnapshot.ts';

const source = `import simplecadapi as scad

# iriscad:parameters
width = 20.0  # [10:1:40]

# iriscad:part base_part
base_solid = scad.make_box_rsolid(width, 10, 4)
base_part = scad.make_part_rpart("base_part", base_solid, name="Base")

# iriscad:assembly_setup
assembly = scad.make_assembly_rassembly("fixture", name="Fixture")

# iriscad:component base_component
assembly = scad.add_component_rassembly(assembly, base_part, "base_component", scad.identity_placement_rplacement(), name="Base")

# iriscad:assembly_result
result = assembly
`;

const artifact = {
  title: 'Fixture',
  version: 'v1',
  code: source,
  artifact_kind: 'assembly' as const,
  model_summary: 'A one-component fixture.',
};

const snapshot: ParametricModelSnapshot = {
  modelRevision: 'm1:c1',
  artifactVersion: 'v1',
  source: { messageId: 'm1', toolCallId: 'c1' },
  artifactKind: 'assembly',
  parameters: [
    {
      name: 'width',
      displayName: 'Width',
      value: 20,
      defaultValue: 20,
      type: 'number',
    },
  ],
  components: [
    {
      component_id: 'base_component',
      component_name: 'Base',
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
  ],
  bom: [{ part_id: 'base_part', part_name: 'Base', quantity: 1 }],
  mateNotes: [],
  recentChanges: [],
  modelSummary: artifact.model_summary,
  savedAt: '2026-08-19T00:00:00Z',
};

const patch = {
  base_model_revision: 'm1:c1',
  replacements: [
    {
      section_kind: 'part' as const,
      section_id: 'base_part',
      replacement_source: `# iriscad:part base_part
base_solid = scad.make_box_rsolid(width, 12, 4)
base_part = scad.make_part_rpart("base_part", base_solid, name="Base")`,
    },
  ],
  affected_component_ids: ['base_component'],
  update_summary: 'Widened the base Part section.',
  planned_changes: 'Widened the base.',
  model_summary: 'A wider one-component fixture.',
};

describe('parametric source history', () => {
  it('merges a bounded patch without copying unrelated sections', () => {
    const merged = mergeParametricComponentPatch({
      baseArtifact: artifact,
      baseSnapshot: snapshot,
      patchInput: patch,
    });
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.match(merged.artifact.code, /make_box_rsolid\(width, 12, 4\)/);
    assert.match(merged.artifact.code, /make_assembly_rassembly\("fixture"/);
    assert.deepEqual(merged.affectedComponentIds, ['base_component']);
    assert.deepEqual(merged.changedSectionKeys, ['part/base_part']);
  });

  it('requires a complete rebuild for an Assembly-result replacement', () => {
    const merged = mergeParametricComponentPatch({
      baseArtifact: artifact,
      baseSnapshot: snapshot,
      patchInput: {
        ...patch,
        replacements: [
          {
            section_kind: 'assembly_result',
            section_id: 'assembly_result',
            replacement_source: `# iriscad:assembly_result
# keep the final Assembly result explicit
result = assembly`,
          },
        ],
      },
    });
    assert.equal(merged.ok, false);
    if (merged.ok) return;
    assert.match(merged.reason, /requires a complete rebuild/);
  });

  it('accepts a complete helper replacement and preserves its key', () => {
    const helperArtifact = {
      ...artifact,
      code: source
        .replace(
          'scad.make_box_rsolid(width, 10, 4)',
          'scad.make_box_rsolid(make_width(), 10, 4)',
        )
        .replace(
          '# iriscad:part base_part',
          '# iriscad:helper make_width\ndef make_width():\n    return width\n\n# iriscad:part base_part',
        ),
    };
    const merged = mergeParametricComponentPatch({
      baseArtifact: helperArtifact,
      baseSnapshot: snapshot,
      patchInput: {
        ...patch,
        replacements: [
          {
            section_kind: 'helper',
            section_id: 'make_width',
            replacement_source: `# iriscad:helper make_width
def make_width():
    return width * 2`,
          },
        ],
      },
    });
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.deepEqual(merged.changedSectionKeys, ['helper/make_width']);
  });

  it('restores a patch that deletes one Part and Component then adds replacements', () => {
    const structuralPatch = {
      ...patch,
      replacements: [],
      additions: [
        {
          section_kind: 'part' as const,
          section_id: 'cap_part',
          section_source: `# iriscad:part cap_part
cap_solid = scad.make_box_rsolid(4, 4, 4)
cap_part = scad.make_part_rpart("cap_part", cap_solid, name="Cap")`,
        },
        {
          section_kind: 'component' as const,
          section_id: 'cap_component',
          section_source: `# iriscad:component cap_component
assembly = scad.add_component_rassembly(assembly, cap_part, "cap_component", scad.identity_placement_rplacement(), name="Cap")`,
        },
      ],
      deletions: [
        { section_kind: 'part' as const, section_id: 'base_part' },
        { section_kind: 'component' as const, section_id: 'base_component' },
      ],
      affected_component_ids: ['base_component', 'cap_component'],
    };
    const merged = mergeParametricComponentPatch({
      baseArtifact: artifact,
      baseSnapshot: snapshot,
      patchInput: structuralPatch,
    });
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.deepEqual(merged.patchImpact, {
      addedComponentIds: ['cap_component'],
      removedComponentIds: ['base_component'],
      changedComponentIds: [],
      addedPartIds: ['cap_part'],
      changedPartIds: [],
      removedPartIds: ['base_part'],
      dirtyPartIds: ['cap_part'],
    });
    const resolved = resolveParametricArtifactRevision(
      [
        {
          id: 'm1',
          role: 'assistant',
          metadata: { modelSnapshot: snapshot },
          parts: [
            {
              type: 'tool-build_parametric_model',
              toolCallId: 'c1',
              state: 'output-available',
              input: artifact,
              output: { status: 'success' },
            },
          ],
        },
        {
          id: 'm2',
          role: 'assistant',
          parts: [
            {
              type: 'tool-patch_parametric_components',
              toolCallId: 'c2',
              state: 'output-available',
              input: structuralPatch,
              output: { status: 'success' },
            },
          ],
        },
      ],
      'm2:c2',
    );
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.match(resolved.artifact.code, /# iriscad:part cap_part/);
    assert.match(resolved.artifact.code, /# iriscad:component cap_component/);
    assert.doesNotMatch(resolved.artifact.code, /# iriscad:part base_part/);
    assert.doesNotMatch(
      resolved.artifact.code,
      /# iriscad:component base_component/,
    );
    assert.ok(
      resolved.artifact.code.indexOf('# iriscad:part cap_part') <
        resolved.artifact.code.indexOf('# iriscad:assembly_setup'),
    );
    assert.ok(
      resolved.artifact.code.indexOf('# iriscad:component cap_component') <
        resolved.artifact.code.indexOf('# iriscad:assembly_result'),
    );
  });

  it('does not dirty an existing Part when adding another Component that reuses it', () => {
    const merged = mergeParametricComponentPatch({
      baseArtifact: artifact,
      baseSnapshot: snapshot,
      patchInput: {
        ...patch,
        replacements: [],
        additions: [
          {
            section_kind: 'component',
            section_id: 'second_base_component',
            section_source: `# iriscad:component second_base_component
assembly = scad.add_component_rassembly(assembly, base_part, "second_base_component", scad.identity_placement_rplacement(), name="Second base")`,
          },
        ],
        affected_component_ids: ['second_base_component'],
      },
    });
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.deepEqual(merged.patchImpact.dirtyPartIds, []);
    assert.deepEqual(merged.patchImpact.removedPartIds, []);
  });

  it('keeps a shared Part when deleting only one of its Components', () => {
    const sharedArtifact = {
      ...artifact,
      code: source.replace(
        '# iriscad:assembly_result',
        `# iriscad:component second_base_component
assembly = scad.add_component_rassembly(assembly, base_part, "second_base_component", scad.identity_placement_rplacement(), name="Second base")

# iriscad:assembly_result`,
      ),
    };
    const sharedSnapshot = {
      ...snapshot,
      components: [
        ...snapshot.components,
        {
          ...snapshot.components[0],
          component_id: 'second_base_component',
          component_name: 'Second base',
        },
      ],
    };
    const merged = mergeParametricComponentPatch({
      baseArtifact: sharedArtifact,
      baseSnapshot: sharedSnapshot,
      patchInput: {
        ...patch,
        replacements: [],
        deletions: [
          { section_kind: 'component', section_id: 'second_base_component' },
        ],
        affected_component_ids: ['second_base_component'],
      },
    });
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.deepEqual(merged.patchImpact.removedPartIds, []);
  });

  it('rejects deletion of a Part still referenced by a Component', () => {
    const resolved = resolveParametricArtifactRevision(
      [
        {
          id: 'm1',
          role: 'assistant',
          metadata: { modelSnapshot: snapshot },
          parts: [
            {
              type: 'tool-build_parametric_model',
              toolCallId: 'c1',
              state: 'output-available',
              input: artifact,
              output: { status: 'success' },
            },
          ],
        },
        {
          id: 'm2',
          role: 'assistant',
          parts: [
            {
              type: 'tool-patch_parametric_components',
              toolCallId: 'c2',
              state: 'output-available',
              input: {
                ...patch,
                replacements: [],
                additions: [
                  {
                    section_kind: 'part',
                    section_id: 'cap_part',
                    section_source:
                      '# iriscad:part cap_part\ncap_part = base_part',
                  },
                ],
                deletions: [{ section_kind: 'part', section_id: 'base_part' }],
              },
              output: { status: 'success' },
            },
          ],
        },
      ],
      'm2:c2',
    );
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.match(resolved.reason, /still references/);
  });

  it('rejects a stale revision and an incomplete impact declaration', () => {
    assert.equal(
      mergeParametricComponentPatch({
        baseArtifact: artifact,
        baseSnapshot: snapshot,
        patchInput: { ...patch, base_model_revision: 'old:revision' },
      }).ok,
      false,
    );
    assert.equal(
      mergeParametricComponentPatch({
        baseArtifact: artifact,
        baseSnapshot: snapshot,
        patchInput: { ...patch, affected_component_ids: ['other_component'] },
      }).ok,
      false,
    );
  });

  it('reconstructs a historical patch from its full-build checkpoint', () => {
    const patchedSnapshot = {
      ...snapshot,
      modelRevision: 'm2:c2',
      source: { messageId: 'm2', toolCallId: 'c2' },
      parameters: snapshot.parameters.map((parameter) => ({
        ...parameter,
        value: 26,
      })),
    };
    const messages = [
      {
        id: 'm1',
        role: 'assistant',
        metadata: { modelSnapshot: snapshot },
        parts: [
          {
            type: 'tool-build_parametric_model',
            toolCallId: 'c1',
            state: 'output-available',
            input: artifact,
            output: { status: 'success' },
          },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        metadata: { modelSnapshot: patchedSnapshot },
        parts: [
          {
            type: 'tool-patch_parametric_components',
            toolCallId: 'c2',
            state: 'output-available',
            input: patch,
            output: { status: 'success' },
          },
        ],
      },
    ];
    const resolved = resolveParametricArtifactRevision(messages, 'm2:c2');
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.match(resolved.artifact.code, /width = 26/);
      assert.match(resolved.artifact.code, /make_box_rsolid\(width, 12, 4\)/);
    }
  });

  it('rejects unapproved protected-rebuild source changes', () => {
    const next = {
      ...artifact,
      code: source.replace('width, 10, 4', 'width, 14, 4'),
    };
    const issues = validateProtectedRebuildSource({
      baseArtifact: artifact,
      baseSnapshot: snapshot,
      nextArtifact: next,
      contract: {
        base_model_revision: 'm1:c1',
        replace_sections: [],
        add_sections: [],
        affected_component_ids: ['base_component'],
      },
    });
    assert.match(issues.join('\n'), /Unapproved section changed/);
  });

  it('does not let protected rebuild authorize global parameter changes', () => {
    const next = {
      ...artifact,
      code: source.replace('width = 20.0', 'width = 24.0'),
    };
    const issues = validateProtectedRebuildSource({
      baseArtifact: artifact,
      baseSnapshot: snapshot,
      nextArtifact: next,
      contract: {
        base_model_revision: 'm1:c1',
        replace_sections: [
          { section_kind: 'parameters', section_id: 'parameters' },
        ],
        add_sections: [],
        affected_component_ids: ['base_component'],
      },
    });
    assert.match(issues.join('\n'), /cannot authorize global parameters/);
  });

  it('rejects changes to unaffected runtime components', () => {
    const changed = snapshot.components.map((component) => ({
      ...component,
      placement: {
        ...component.placement,
        origin: [5, 0, 0] as [number, number, number],
      },
    }));
    const issues = validateProtectedRebuildRuntime({
      baseSnapshot: snapshot,
      nextComponents: changed,
      contract: {
        base_model_revision: 'm1:c1',
        replace_sections: [],
        add_sections: [],
        affected_component_ids: ['another_component'],
      },
    });
    assert.match(
      issues.join('\n'),
      /Unaffected component metadata or Placement changed/,
    );
  });
});

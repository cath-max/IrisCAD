import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createParametricModelSnapshot,
  recentSuccessfulModelChanges,
  refreshSnapshotParameters,
  refreshSnapshotAssemblyVisibility,
} from './modelSnapshot.ts';
import {
  parametricArtifactSchema,
  patchParametricComponentsSchema,
} from './chatAi.ts';

describe('Parametric model snapshot', () => {
  const artifact = {
    title: 'Bracket',
    version: 'v1',
    code: 'import simplecadapi as scad\nresult = scad.make_box_rsolid(1, 1, 1)',
    artifact_kind: 'model' as const,
    model_summary: 'A single rectangular mounting bracket.',
  };
  const parameters = [
    {
      name: 'width',
      displayName: 'Width',
      value: 10,
      defaultValue: 10,
      type: 'number' as const,
    },
  ];

  it('stores a source reference instead of a second source-code copy', () => {
    const snapshot = createParametricModelSnapshot({
      messageId: 'message-1',
      toolCallId: 'call-1',
      artifact,
      parameters,
      recentChanges: ['Widened the bracket.'],
      savedAt: '2026-08-19T00:00:00.000Z',
    });
    assert.equal(snapshot.modelRevision, 'message-1:call-1');
    assert.deepEqual(snapshot.source, {
      messageId: 'message-1',
      toolCallId: 'call-1',
    });
    assert.equal('code' in snapshot, false);
    assert.equal(snapshot.modelSummary, artifact.model_summary);
  });

  it('keeps only two newest successful change descriptions', () => {
    const changes = recentSuccessfulModelChanges([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-build_parametric_model',
            state: 'output-available',
            input: { planned_changes: 'Older successful change.' },
            output: { status: 'success' },
          },
        ],
      },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-build_parametric_model',
            state: 'output-available',
            input: { planned_changes: 'Newest successful change.' },
            output: { status: 'success' },
          },
        ],
      },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-build_parametric_model',
            state: 'output-available',
            input: { planned_changes: 'Failed change.' },
            output: { status: 'error' },
          },
        ],
      },
    ]);
    assert.deepEqual(changes, [
      'Newest successful change.',
      'Older successful change.',
    ]);
  });

  it('refreshes parameter values without changing the revision or source', () => {
    const snapshot = createParametricModelSnapshot({
      messageId: 'message-1',
      toolCallId: 'call-1',
      artifact,
      parameters,
      recentChanges: [],
      savedAt: '2026-08-19T00:00:00.000Z',
    });
    const refreshed = refreshSnapshotParameters(
      snapshot,
      [{ ...parameters[0], value: 25 }],
      '2026-08-19T01:00:00.000Z',
    );
    assert.equal(refreshed.modelRevision, snapshot.modelRevision);
    assert.deepEqual(refreshed.source, snapshot.source);
    assert.equal(refreshed.parameters[0].value, 25);
  });

  it('keeps per-version Assembly visibility in compact snapshot metadata', () => {
    const snapshot = createParametricModelSnapshot({
      messageId: 'message-1',
      toolCallId: 'call-1',
      artifact: {
        ...artifact,
        artifact_kind: 'assembly',
        assembly_visibility: { base: true },
      },
      parameters,
      recentChanges: [],
      savedAt: '2026-08-19T00:00:00.000Z',
    });
    const refreshed = refreshSnapshotAssemblyVisibility(
      snapshot,
      { base: false },
      '2026-08-19T01:00:00.000Z',
    );
    assert.deepEqual(refreshed.assemblyVisibility, { base: false });
    assert.equal(refreshed.modelRevision, snapshot.modelRevision);
  });

  it('requires a same-call compact model summary for new tool artifacts', () => {
    const withoutSummary = { ...artifact };
    delete (withoutSummary as { model_summary?: string }).model_summary;
    assert.equal(
      parametricArtifactSchema.safeParse(withoutSummary).success,
      false,
    );
    assert.equal(parametricArtifactSchema.safeParse(artifact).success, true);
  });

  it('accepts bounded local section operations and rejects invalid patches', () => {
    const patch = {
      base_model_revision: 'message-1:call-1',
      replacements: [
        {
          section_kind: 'part' as const,
          section_id: 'gear_part',
          replacement_source: [
            '# iriscad:part gear_part',
            'gear_part = make_gear()',
          ].join('\n'),
        },
      ],
      affected_component_ids: ['gear_center'],
      update_summary: 'Replaced the gear Part section.',
      planned_changes: 'Made the center gear thicker.',
      model_summary: 'A base, support, and center spur gear Assembly.',
    };
    assert.equal(
      patchParametricComponentsSchema.safeParse(patch).success,
      true,
    );
    assert.equal(
      patchParametricComponentsSchema.safeParse({
        ...patch,
        base_model_revision: '',
      }).success,
      false,
    );
    assert.equal(
      patchParametricComponentsSchema.safeParse({
        ...patch,
        replacements: [{ ...patch.replacements[0], section_kind: 'helper' }],
      }).success,
      true,
    );
    assert.equal(
      patchParametricComponentsSchema.safeParse({
        ...patch,
        replacements: [],
        additions: [
          {
            section_kind: 'part',
            section_id: 'reflector_part',
            section_source:
              '# iriscad:part reflector_part\nreflector_part = make_reflector()',
          },
          {
            section_kind: 'component',
            section_id: 'rear_reflector',
            section_source:
              '# iriscad:component rear_reflector\nassembly.add_part(reflector_part)',
          },
        ],
        deletions: [{ section_kind: 'component', section_id: 'old_reflector' }],
        affected_component_ids: ['rear_reflector', 'old_reflector'],
      }).success,
      true,
    );
    assert.equal(
      patchParametricComponentsSchema.safeParse({
        ...patch,
        replacements: [],
      }).success,
      false,
    );
    assert.equal(
      patchParametricComponentsSchema.safeParse({
        ...patch,
        additions: Array.from({ length: 12 }, (_, index) => ({
          section_kind: 'part' as const,
          section_id: `added_part_${index}`,
          section_source: `# iriscad:part added_part_${index}\nadded_part_${index} = make_part()`,
        })),
      }).success,
      false,
    );
    assert.equal(
      patchParametricComponentsSchema.safeParse({
        ...patch,
        deletions: [{ section_kind: 'parameters', section_id: 'parameters' }],
      }).success,
      false,
    );
  });
});

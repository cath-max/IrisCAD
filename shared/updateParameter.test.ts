import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { updateParameter } from './updateParameter.ts';
import type { Parameter } from './types.ts';

function num(name: string, value: number): Parameter {
  return {
    name,
    displayName: name,
    value,
    defaultValue: value,
    type: 'number',
  };
}

function bool(name: string, value: boolean): Parameter {
  return {
    name,
    displayName: name,
    value,
    defaultValue: value,
    type: 'boolean',
  };
}

function str(name: string, value: string): Parameter {
  return {
    name,
    displayName: name,
    value,
    defaultValue: value,
    type: 'string',
  };
}

describe('updateParameter Python', () => {
  it('rewrites literal without adding semicolon and keeps range comment', () => {
    const code =
      'import simplecadapi as scad\ncup_height = 100.0  # [50:200]\n';
    const next = updateParameter(code, num('cup_height', 120));
    assert.equal(
      next,
      'import simplecadapi as scad\ncup_height = 120  # [50:200]\n',
    );
  });

  it('auto-detects python from simplecadapi import', () => {
    const code = 'import simplecadapi as scad\nr = 40.0\n';
    const next = updateParameter(code, num('r', 55));
    assert.match(next, /^import simplecadapi as scad\nr = 55\n$/);
  });

  it('writes Python True/False and string quotes', () => {
    const code = 'import simplecadapi as scad\nenabled = False\nlabel = "a"\n';
    let next = updateParameter(code, bool('enabled', true));
    next = updateParameter(next, str('label', 'mug'));
    assert.match(next, /enabled = True/);
    assert.match(next, /label = "mug"/);
  });

  it('preserves indentation', () => {
    const code = 'import simplecadapi as scad\n  w = 1.0  # [0:5]\n';
    const next = updateParameter(code, num('w', 2));
    assert.equal(next, 'import simplecadapi as scad\n  w = 2  # [0:5]\n');
  });
});

import type { Parameter } from './types.ts';

/**
 * Rewrite a top-level parameter assignment in SimpleCADAPI Python.
 * Preserves trailing `# ...` comments.
 */
export function updateParameter(code: string, param: Parameter): string {
  return updatePythonParameter(code, param);
}

function updatePythonParameter(code: string, param: Parameter): string {
  const escapedName = escapeRegExp(param.name);
  // Keep trailing `# ...` annotations (ranges / notes) intact.
  const regex = new RegExp(
    `^(\\s*${escapedName}\\s*=\\s*)([^#\\n]+?)([ \\t]*#[^\\n]*)?(\\s*)$`,
    'm',
  );
  const formatted = escapeReplacement(formatPythonValue(param));
  return code.replace(regex, `$1${formatted}$3$4`);
}

function formatPythonValue(param: Parameter): string {
  if (!param.type) {
    if (typeof param.value === 'boolean') {
      return param.value ? 'True' : 'False';
    }
    if (typeof param.value === 'string') {
      return `"${escapeQuotes(param.value)}"`;
    }
    return String(param.value);
  }
  switch (param.type) {
    case 'string':
      return `"${escapeQuotes(param.value as string)}"`;
    case 'number':
      return String(param.value);
    case 'boolean':
      return param.value ? 'True' : 'False';
    case 'string[]':
      return `[${(param.value as string[])
        .map((value) => `"${escapeQuotes(value)}"`)
        .join(', ')}]`;
    case 'number[]':
      return `[${(param.value as number[]).join(', ')}]`;
    case 'boolean[]':
      return `[${(param.value as boolean[])
        .map((value) => (value ? 'True' : 'False'))
        .join(', ')}]`;
    default:
      return String(param.value);
  }
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeReplacement(string: string) {
  return string.replace(/\$/g, '$$$$');
}

function escapeQuotes(string: string) {
  return string.replace(/"/g, '\\"');
}

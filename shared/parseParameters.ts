import type {
  Parameter,
  ParameterOption,
  ParameterRange,
  ParameterType,
} from './types.ts';

/** Extract editable literal assignments from the top of SimpleCADAPI Python. */
export default function parseParameters(script: string): Parameter[] {
  script = script.split(/^(def |class )/m)[0];
  const parameters: Record<string, Parameter> = {};
  const assignment =
    /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([^#\n]+?)[ \t]*(#[^\n]*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(script)) !== null) {
    const name = match[1];
    const rawValue = match[2].trim();
    let parsed: { value: Parameter['value']; type: ParameterType };
    try {
      parsed = convertType(rawValue);
    } catch {
      continue;
    }
    if (/^[a-zA-Z_]/.test(rawValue) && !/^(True|False)$/.test(rawValue))
      continue;
    const annotation = parseAnnotation(
      match[3]?.replace(/^#\s*/, '').trim() ?? '',
      parsed.type,
    );
    const displayName = toDisplayName(name);
    const description = descriptionAbove(script, match[0]);
    if (parsed.type === 'number[]' && Array.isArray(parsed.value)) {
      const labels = numberArrayLabels(name, parsed.value.length);
      parsed.value.forEach((value, index) => {
        parameters[`${name}[${index}]`] = {
          description,
          group: '',
          name: `${name}[${index}]`,
          displayName: displayNameForArrayItem(displayName, labels[index]),
          defaultValue: value,
          ...annotation,
          value,
          type: 'number',
        };
      });
      continue;
    }
    parameters[name] = {
      description,
      group: '',
      name,
      displayName,
      defaultValue: parsed.value,
      ...annotation,
      ...parsed,
    };
  }
  return Object.values(parameters);
}

function parseAnnotation(
  comment: string,
  type: ParameterType,
): { options: ParameterOption[]; range: ParameterRange } {
  let options: ParameterOption[] = [];
  const range: ParameterRange = {};
  const bracket = comment.match(/\[([^\]]*)\]/);
  if (!bracket) return { options, range };
  const value = bracket[1].trim();
  if (value.includes(',')) {
    options = value.split(',').map((item) => {
      const [raw, label] = item.trim().split(':');
      return { value: type === 'number' ? parseFloat(raw) : raw, label };
    });
  } else if (/^-?\d+(\.\d+)?(:-?\d+(\.\d+)?)*$/.test(value)) {
    const [min, maxOrStep, max] = value.split(':').map(Number);
    if (maxOrStep !== undefined) range.min = min;
    range.max = max ?? maxOrStep ?? min;
    if (max !== undefined) range.step = maxOrStep;
  }
  return { options, range };
}

function descriptionAbove(script: string, matchedLine: string) {
  let above = script.split(
    new RegExp(`^${escapeRegExp(matchedLine)}`, 'gm'),
  )[0];
  if (above.endsWith('\n')) above = above.slice(0, -1);
  const line = above.split('\n').at(-1)?.trim() ?? '';
  return line.startsWith('#')
    ? line.replace(/^#\s*/, '').trim() || undefined
    : undefined;
}

function convertType(raw: string): {
  value: Parameter['value'];
  type: ParameterType;
} {
  const value = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(value))
    return { value: Number(value), type: 'number' };
  if (/^(True|False)$/.test(value))
    return { value: value === 'True', type: 'boolean' };
  if (/^(["']).*\1$/.test(value))
    return { value: value.slice(1, -1), type: 'string' };
  if (value.startsWith('[') && value.endsWith(']')) {
    const items = value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (items.every((item) => /^-?\d+(\.\d+)?$/.test(item)))
      return { value: items.map(Number), type: 'number[]' };
    if (items.every((item) => /^(["']).*\1$/.test(item)))
      return {
        value: items.map((item) => item.slice(1, -1)),
        type: 'string[]',
      };
    if (items.every((item) => /^(True|False)$/.test(item)))
      return { value: items.map((item) => item === 'True'), type: 'boolean[]' };
  }
  throw new Error(`Invalid literal: ${raw}`);
}

function toDisplayName(name: string) {
  return name
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}
function numberArrayLabels(name: string, length: number) {
  if (length === 2) return ['X', 'Y'];
  if (length !== 3) return Array.from({ length }, (_, index) => `${index + 1}`);
  return /(size|dimension|body|torso|head|foot|base)/i.test(name)
    ? ['Width', 'Depth', 'Height']
    : ['X', 'Y', 'Z'];
}
function displayNameForArrayItem(name: string, label: string) {
  return ['Width', 'Depth', 'Height'].includes(label)
    ? name.replace(/\s+Size$/i, '') + ` ${label}`
    : `${name} ${label}`;
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

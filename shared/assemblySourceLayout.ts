export const ASSEMBLY_SOURCE_SECTION_KINDS = [
  'parameters',
  'helper',
  'part',
  'assembly_setup',
  'component',
  'assembly_result',
] as const;

export type AssemblySourceSectionKind =
  (typeof ASSEMBLY_SOURCE_SECTION_KINDS)[number];

export type AssemblySourceSection = {
  kind: AssemblySourceSectionKind;
  id: string;
  startLine: number;
  endLine: number;
  source: string;
};

export type AssemblySourceLayout = {
  sections: AssemblySourceSection[];
};

export type AssemblySourceLayoutValidation =
  | { ok: true; layout: AssemblySourceLayout }
  | { ok: false; issues: string[] };

export const ASSEMBLY_SOURCE_LAYOUT_GUIDANCE = `Exact Assembly source-layout contract:
- After the first \`import simplecadapi as scad\`, every executable statement must be inside exactly one section; these section markers are Python comments and do not change geometry.
- Use exactly one lowercase marker at the beginning of each section. A section ends at the next IrisCAD marker or EOF:
  # iriscad:part base_part
  ...
- The IDs for \`parameters\`, \`assembly_setup\`, and \`assembly_result\` are implicit; every other section marker requires a lower_snake_case English ID matching \`[a-z][a-z0-9_]*\`.
- Required order/count: exactly one parameters/parameters; zero or more helper/<helper_id>; one or more part/<part_id> sections, exactly one per Part; exactly one assembly_setup/assembly_setup; one or more component/<component_id> sections, exactly one per component; one assembly_result/assembly_result.
- For incremental execution, each helper section must contain exactly one top-level \`def\`; its function name and helper_id must match (for example \`# iriscad:helper make_hollow_grip\` followed by \`def make_hollow_grip(...):\`). Put dependent helpers in separate source-ordered helper sections. Do not group unrelated helper functions in one section.
- Keep each Part definition in its matching part block, each Placement plus \`add_component_rassembly\` call in its matching component block, and \`result = assembly\` in the final block. Never group multiple Part definitions or component instances in one block.`;

const SECTION_START_RE = /^#\s*iriscad:([a-z_]+)(?:\s+([a-z][a-z0-9_]*))?\s*$/;
const SECTION_RANK: Record<AssemblySourceSectionKind, number> = {
  parameters: 0,
  helper: 1,
  part: 2,
  assembly_setup: 3,
  component: 4,
  assembly_result: 5,
};

function isSectionKind(value: string): value is AssemblySourceSectionKind {
  return (ASSEMBLY_SOURCE_SECTION_KINDS as readonly string[]).includes(value);
}

function countSections(
  sections: readonly AssemblySourceSection[],
  kind: AssemblySourceSectionKind,
): number {
  return sections.filter((section) => section.kind === kind).length;
}

function formatLineRanges(lines: readonly number[]): string {
  const ranges: string[] = [];
  let start = lines[0];
  let end = start;
  for (const line of lines.slice(1)) {
    if (line === end + 1) {
      end = line;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = line;
    end = line;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(', ');
}

/**
 * Validate the marker layout required for newly generated Assembly scripts.
 * The markers are Python comments, so they never change SimpleCADAPI execution.
 */
export function validateAssemblySourceLayout(
  code: string,
): AssemblySourceLayoutValidation {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const issues: string[] = [];
  const sections: AssemblySourceSection[] = [];
  const unsectionedExecutableLines: number[] = [];
  let open:
    | {
        kind: AssemblySourceSectionKind;
        id: string;
        startLine: number;
        bodyStart: number;
      }
    | undefined;
  let lastRank = -1;

  if (lines[0]?.trim() !== 'import simplecadapi as scad') {
    issues.push(
      'Assembly source must start with `import simplecadapi as scad`.',
    );
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const startMatch = line.match(SECTION_START_RE);

    if (startMatch) {
      const [, rawKind, explicitId] = startMatch;
      if (open) {
        sections.push({
          kind: open.kind,
          id: open.id,
          startLine: open.startLine,
          endLine: index,
          source: lines.slice(open.bodyStart, index).join('\n'),
        });
      }
      if (!isSectionKind(rawKind)) {
        issues.push(
          `Line ${index + 1}: unsupported Assembly section kind \`${rawKind}\`.`,
        );
        open = undefined;
        continue;
      }
      const implicitId =
        rawKind === 'parameters' ||
        rawKind === 'assembly_setup' ||
        rawKind === 'assembly_result'
          ? rawKind
          : undefined;
      if ((implicitId && explicitId) || (!implicitId && !explicitId)) {
        issues.push(
          implicitId
            ? `Line ${index + 1}: ${rawKind} must not declare an ID.`
            : `Line ${index + 1}: ${rawKind} requires an ID.`,
        );
        open = undefined;
        continue;
      }
      const id = explicitId ?? implicitId;
      const rank = SECTION_RANK[rawKind];
      if (rank < lastRank) {
        issues.push(
          `Line ${index + 1}: ${rawKind} sections must appear after earlier section kinds.`,
        );
      }
      lastRank = Math.max(lastRank, rank);
      open = { kind: rawKind, id, startLine: index + 1, bodyStart: index + 1 };
      continue;
    }

    if (!open && index > 0 && line.trim() && !line.trim().startsWith('#')) {
      unsectionedExecutableLines.push(index + 1);
    }
  }

  if (unsectionedExecutableLines.length > 0) {
    const label = unsectionedExecutableLines.length === 1 ? 'Line' : 'Lines';
    issues.push(
      `${label} ${formatLineRanges(unsectionedExecutableLines)}: executable code must be inside an IrisCAD Assembly section.`,
    );
  }

  if (open) {
    sections.push({
      kind: open.kind,
      id: open.id,
      startLine: open.startLine,
      endLine: lines.length,
      source: lines.slice(open.bodyStart).join('\n'),
    });
  }

  const seen = new Set<string>();
  for (const section of sections) {
    const key = `${section.kind}/${section.id}`;
    if (seen.has(key)) {
      issues.push(`Duplicate Assembly section \`${key}\`.`);
    }
    seen.add(key);
  }

  if (
    countSections(sections, 'parameters') !== 1 ||
    !sections.some(
      (section) => section.kind === 'parameters' && section.id === 'parameters',
    )
  ) {
    issues.push(
      'Assembly source requires exactly one `parameters` section with id `parameters`.',
    );
  }
  if (countSections(sections, 'part') < 1) {
    issues.push('Assembly source requires at least one `part` section.');
  }
  if (
    countSections(sections, 'assembly_setup') !== 1 ||
    !sections.some(
      (section) =>
        section.kind === 'assembly_setup' && section.id === 'assembly_setup',
    )
  ) {
    issues.push(
      'Assembly source requires exactly one `assembly_setup` section with id `assembly_setup`.',
    );
  }
  if (countSections(sections, 'component') < 1) {
    issues.push('Assembly source requires at least one `component` section.');
  }
  if (
    countSections(sections, 'assembly_result') !== 1 ||
    !sections.some(
      (section) =>
        section.kind === 'assembly_result' && section.id === 'assembly_result',
    )
  ) {
    issues.push(
      'Assembly source requires exactly one `assembly_result` section with id `assembly_result`.',
    );
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, layout: { sections } };
}

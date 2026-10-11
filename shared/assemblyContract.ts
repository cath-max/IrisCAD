export type AssemblyPlacement = {
  origin: [number, number, number];
  x_axis: [number, number, number];
  y_axis: [number, number, number];
  z_axis: [number, number, number];
};

export type AssemblyComponent = {
  component_id: string;
  component_name: string | null;
  item_kind: 'part' | 'assembly';
  part_id: string | null;
  part_name: string | null;
  placement: AssemblyPlacement;
};

export type AssemblyBomLine = {
  part_id: string;
  part_name: string;
  quantity: number;
};

export type AssemblyStructure = {
  assembly_id: string;
  name: string | null;
  components: AssemblyComponent[];
  bom: AssemblyBomLine[];
};

export const MATE_NOTE_KINDS = ['coaxial', 'face_contact', 'offset'] as const;

export type MateNoteKind = (typeof MATE_NOTE_KINDS)[number];

/** V1-only assembly intent metadata; it does not solve or alter geometry. */
export type MateNote = {
  note_id: string;
  kind: MateNoteKind;
  component_ids: [string, string];
  description: string;
  intended_offset_mm?: number;
};

function isVector3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function hasPlacement(value: unknown): value is AssemblyPlacement {
  if (!value || typeof value !== 'object') return false;
  const placement = value as Record<string, unknown>;
  return (
    isVector3(placement.origin) &&
    isVector3(placement.x_axis) &&
    isVector3(placement.y_axis) &&
    isVector3(placement.z_axis)
  );
}

/** Return V1 Assembly contract violations found in a WebHarness snapshot. */
export function validateV1AssemblyStructure(
  structure: AssemblyStructure | null,
): string[] {
  if (!structure) return ['Assembly structure details were not returned.'];
  if (!structure.assembly_id.trim())
    return ['Assembly is missing assembly_id.'];
  if (structure.components.length === 0)
    return ['Assembly must contain at least one Part component.'];

  const seenComponentIds = new Set<string>();
  const violations: string[] = [];
  for (const component of structure.components) {
    if (!component.component_id.trim()) {
      violations.push('Assembly component is missing component_id.');
    } else if (seenComponentIds.has(component.component_id)) {
      violations.push(`Duplicate component_id: ${component.component_id}.`);
    } else {
      seenComponentIds.add(component.component_id);
    }
    if (component.item_kind !== 'part') {
      violations.push(
        `Component ${component.component_id || '(unknown)'} is a subassembly; V1 accepts only direct Part components.`,
      );
    }
    if (!component.part_id?.trim()) {
      violations.push(
        `Component ${component.component_id || '(unknown)'} is missing part_id.`,
      );
    }
    if (!component.component_name?.trim()) {
      violations.push(
        `Component ${component.component_id || '(unknown)'} is missing a name.`,
      );
    }
    if (!component.part_name?.trim()) {
      violations.push(
        `Component ${component.component_id || '(unknown)'} has a Part without a name.`,
      );
    }
    if (!hasPlacement(component.placement)) {
      violations.push(
        `Component ${component.component_id || '(unknown)'} has an invalid Placement.`,
      );
    }
  }
  return violations;
}

/** Check note syntax and ensure every referenced component exists at runtime. */
export function validateV1MateNotes(
  mateNotes: readonly MateNote[],
  componentIds: ReadonlySet<string>,
): string[] {
  const noteIds = new Set<string>();
  const violations: string[] = [];
  for (const note of mateNotes) {
    if (!note.note_id.trim()) {
      violations.push('mate_note is missing note_id.');
    } else if (noteIds.has(note.note_id)) {
      violations.push(`Duplicate mate_note note_id: ${note.note_id}.`);
    } else {
      noteIds.add(note.note_id);
    }
    if (!MATE_NOTE_KINDS.includes(note.kind)) {
      violations.push(
        `mate_note ${note.note_id || '(unknown)'} has an unsupported kind.`,
      );
    }
    const [firstComponentId, secondComponentId] = note.component_ids;
    if (!firstComponentId || !secondComponentId) {
      violations.push(
        `mate_note ${note.note_id || '(unknown)'} must reference exactly two component_ids.`,
      );
    } else if (firstComponentId === secondComponentId) {
      violations.push(
        `mate_note ${note.note_id || '(unknown)'} cannot reference one component twice.`,
      );
    } else {
      for (const componentId of note.component_ids) {
        if (!componentIds.has(componentId)) {
          violations.push(
            `mate_note ${note.note_id || '(unknown)'} references missing component_id: ${componentId}.`,
          );
        }
      }
    }
    if (!note.description.trim()) {
      violations.push(
        `mate_note ${note.note_id || '(unknown)'} is missing a description.`,
      );
    }
    if (
      note.intended_offset_mm !== undefined &&
      !Number.isFinite(note.intended_offset_mm)
    ) {
      violations.push(
        `mate_note ${note.note_id || '(unknown)'} has an invalid intended_offset_mm.`,
      );
    }
  }
  return violations;
}

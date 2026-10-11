import { tool, type InferUITools, type UIMessage } from 'ai';
import { z } from 'zod';
import type { Model, ProtectedRebuildContract } from './types.ts';
import {
  MATE_NOTE_KINDS,
  type AssemblyBomLine,
  type AssemblyComponent,
  type MateNote,
} from './assemblyContract.ts';
import type { ParametricModelSnapshot } from './modelSnapshot.ts';

const vector3Schema = z.tuple([z.number(), z.number(), z.number()]);
const assemblyComponentSchema: z.ZodType<AssemblyComponent> = z.object({
  component_id: z.string(),
  component_name: z.string().nullable(),
  item_kind: z.enum(['part', 'assembly']),
  part_id: z.string().nullable(),
  part_name: z.string().nullable(),
  placement: z.object({
    origin: vector3Schema,
    x_axis: vector3Schema,
    y_axis: vector3Schema,
    z_axis: vector3Schema,
  }),
});

const assemblyBomLineSchema: z.ZodType<AssemblyBomLine> = z.object({
  part_id: z.string(),
  part_name: z.string(),
  quantity: z.number().int().positive(),
});

const mateNoteSchema: z.ZodType<MateNote> = z.object({
  note_id: z.string().min(1),
  kind: z.enum(MATE_NOTE_KINDS),
  component_ids: z.tuple([z.string().min(1), z.string().min(1)]),
  description: z.string().min(1),
  intended_offset_mm: z.number().finite().optional(),
});

const protectedRebuildSectionSchema = z.object({
  section_kind: z.enum([
    'parameters',
    'helper',
    'part',
    'assembly_setup',
    'component',
    'assembly_result',
  ]),
  section_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
});

const protectedRebuildSchema: z.ZodType<ProtectedRebuildContract> = z.object({
  base_model_revision: z.string().min(1),
  replace_sections: z.array(protectedRebuildSectionSchema).max(12),
  add_sections: z.array(protectedRebuildSectionSchema).max(12),
  affected_component_ids: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
    .min(1)
    .max(6),
  allow_mate_notes_change: z.boolean().optional(),
});

/**
 * Parametric artifact from the model.
 * `code` is complete SimpleCADAPI Python under the MVP contract. The declared
 * `artifact_kind` determines whether top-level `result` is Solid|Compound or
 * Assembly. See docs/MVP_AGENT_CONTRACT.md.
 */
export const parametricArtifactSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      'Short part or assembly name only; a noun phrase without Create, Build, Generate, Design, Make or equivalent introductory verbs.',
    ),
  version: z.string().default('v1'),
  code: z.string().min(20),
  artifact_kind: z
    .enum(['model', 'assembly'])
    .default('model')
    .describe(
      'Use `assembly` only when the user requests multiple independent, detachable, or separately countable parts. Use `model` for one manufactured part; it remains the default for existing workflows.',
    ),
  mate_notes: z
    .array(mateNoteSchema)
    .optional()
    .describe(
      'Assembly-only intent notes. Each note describes a pair of component_ids using coaxial, face_contact, or offset. These notes do not solve constraints or alter Placement.',
    ),
  planned_changes: z
    .string()
    .max(500)
    .optional()
    .describe(
      'When resubmitting after a successful build to revise geometry: 1–3 short sentences on what this revision changes vs the previous version. Omit on the first build and on ErrorGuidance-only compile fixes.',
    ),
  model_summary: z
    .string()
    .min(1)
    .max(700)
    .describe(
      'A compact 1–4 sentence factual summary of the final model: main parts, key dimensions or relationships, and important detachable/functional intent. This is saved for later edits; do not include reasoning, tool names, or a change log.',
    ),
  protected_rebuild: protectedRebuildSchema
    .optional()
    .describe(
      'Use only when IrisCAD explicitly supplies a protected-rebuild contract. The browser rejects every changed or added source section not listed here and verifies unaffected runtime components.',
    ),
});

/** Mirrors SimpleCADAPI `ErrorGuidance` / `SimpleCADError.to_dict()`. */
export const errorGuidanceSchema = z.object({
  operation: z.string().nullable(),
  what_happened: z.string(),
  possible_causes: z.array(z.string()),
  how_to_fix: z.array(z.string()),
  technical_details: z.string().nullable(),
  signature: z.string().nullable(),
  documentation_hint: z.string().nullable(),
});

export const parametricCompileSuccessSchema = z.object({
  status: z.literal('success'),
  message: z.string(),
  artifact_kind: z.enum(['model', 'assembly']),
  result_type: z.enum(['Solid', 'Compound', 'Assembly']),
  assembly: z
    .object({ assembly_id: z.string(), name: z.string().nullable() })
    .optional(),
  components: z.array(assemblyComponentSchema).optional(),
  bom: z.array(assemblyBomLineSchema).optional(),
  mate_notes: z.array(mateNoteSchema).optional(),
  assembly_step: z.object({ available: z.boolean() }).optional(),
  shapes: z.array(z.string()).optional(),
  inspection: z
    .object({
      views: z.array(
        z.enum(['ISO', 'FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'BOTTOM']),
      ),
      imageAttached: z.boolean(),
    })
    .optional(),
  geometry: z
    .object({
      volume: z.number(),
      bbox: z.object({
        min: z.tuple([z.number(), z.number(), z.number()]),
        max: z.tuple([z.number(), z.number(), z.number()]),
      }),
    })
    .optional(),
});

export const parametricCompileErrorSchema = z.object({
  status: z.literal('error'),
  message: z.string(),
  errorGuidance: errorGuidanceSchema.nullable(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  shapes: z.array(z.string()).optional(),
});

export const parametricCompileOutputSchema = z.discriminatedUnion('status', [
  parametricCompileSuccessSchema,
  parametricCompileErrorSchema,
]);

export type ErrorGuidancePayload = z.infer<typeof errorGuidanceSchema>;
export type ParametricCompileOutput = z.infer<
  typeof parametricCompileOutputSchema
>;

/** G3: tool output when user Continues with guidance instead of running code. */
export const USER_BUILD_GUIDANCE_PREFIX =
  'User declined to run this revision and provided build guidance.';

export const answerUserSchema = z.object({
  message: z.string().min(1),
});

const patchReplacementSchema = z.object({
  section_kind: z.enum([
    'parameters',
    'helper',
    'part',
    'assembly_setup',
    'component',
    'assembly_result',
  ]),
  section_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  replacement_source: z
    .string()
    .min(1)
    .describe(
      'The entire replacement Assembly section, beginning with its single `# iriscad:<kind> [id]` marker. It must keep the supplied section_kind and section_id; the next IrisCAD marker or EOF ends the section.',
    ),
});

const patchAdditionSchema = z.object({
  section_kind: z.enum(['part', 'component']),
  section_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  section_source: z
    .string()
    .min(1)
    .describe(
      'The complete new `part` or `component` Assembly section, beginning with its matching single `# iriscad:<kind> <id>` marker.',
    ),
});

const patchDeletionSchema = z.object({
  section_kind: z.enum(['part', 'component']),
  section_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
});

/**
 * Local Assembly edit contract. It deliberately carries no complete Python
 * source: the later executor uses `base_model_revision` to locate the saved
 * source, validates these marked replacements, merges, and runs it.
 */
export const patchParametricComponentsSchema = z
  .object({
    base_model_revision: z
      .string()
      .min(1)
      .describe(
        'The exact IrisCAD model revision supplied in the Local Patch Workset.',
      ),
    replacements: z
      .array(patchReplacementSchema)
      .max(12)
      .default([])
      .describe('Complete marked existing Assembly sections to replace.'),
    additions: z
      .array(patchAdditionSchema)
      .max(12)
      .default([])
      .describe(
        'Complete new Part or Component sections. New Parts are inserted before assembly_setup; new Components before assembly_result.',
      ),
    deletions: z
      .array(patchDeletionSchema)
      .max(12)
      .default([])
      .describe('Existing complete Part or Component sections to delete.'),
    affected_component_ids: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
      .min(1)
      .max(6)
      .describe(
        'Every Assembly component whose geometry or Placement is affected, including added or deleted component IDs.',
      ),
    update_summary: z
      .string()
      .min(1)
      .max(500)
      .describe('A short factual description of the code sections changed.'),
    planned_changes: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'One to three short user-facing sentences describing what changed in the model.',
      ),
    model_summary: z
      .string()
      .min(1)
      .max(700)
      .describe(
        'The updated compact factual model summary for the successful-model snapshot.',
      ),
  })
  .superRefine((patch, context) => {
    const operations = [
      ...patch.replacements.map((section) => ({
        kind: 'replace',
        key: `${section.section_kind}/${section.section_id}`,
      })),
      ...patch.additions.map((section) => ({
        kind: 'add',
        key: `${section.section_kind}/${section.section_id}`,
      })),
      ...patch.deletions.map((section) => ({
        kind: 'delete',
        key: `${section.section_kind}/${section.section_id}`,
      })),
    ];
    if (operations.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A local patch needs at least one replacement, addition, or deletion.',
      });
    }
    if (operations.length > 12) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A local patch may contain at most 12 total section operations.',
      });
    }
    const seen = new Set<string>();
    for (const operation of operations) {
      if (seen.has(operation.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A section may appear in only one patch operation: ${operation.key}.`,
        });
      }
      seen.add(operation.key);
    }
  });

export const chatTools = {
  build_parametric_model: tool({
    description:
      'Create or update the complete SimpleCADAPI Python artifact. `code` must start with `import simplecadapi as scad` and assign the final value to top-level `result`. Declare `artifact_kind: "model"` when `result` is a Solid or Compound; declare `artifact_kind: "assembly"` only for multiple independent, detachable, or separately countable Part instances, with `result` as an Assembly. Do not use Compound to disguise an Assembly. Assembly code must use the required IrisCAD comment sections: one `parameters/parameters`, optional `helper/*`, one or more `part/*`, one `assembly_setup/assembly_setup`, one or more `component/*`, and one `assembly_result/assembly_result`, in that order. For incremental execution, each `helper/<helper_id>` must contain exactly one top-level `def` with the same name as helper_id; use separate source-ordered helper sections for every helper function, never one shared helpers block. The browser executes it with Pyodide + OCP.wasm and returns ErrorGuidance. Both modes return a seven-view inspection sheet; Assembly views are an internal Compound projection while the real Assembly remains the export result. Assembly provides XCAF STEP only, never STL. After a successful build: (1) visually inspect every view against the user request — and against any user reference image(s) in the conversation as the true visual target (silhouette, major parts, proportions, orientation); do not divert attention to a vision feature-summary block during this review — then list defects; (2) run intent self-check of code ↔ user text only (named features/sizes/constraints present; no omissions or unrelated extras — do not re-do seven views or photo-likeness in that step); then resubmit one complete corrected script for any gaps — never patch incrementally in chat text. When resubmitting after a successful build to change shape, set `planned_changes` to 1–3 short sentences describing what this revision changes vs the previous version (omit on the first build and on ErrorGuidance-only compile fixes). When reference images are present, do not call answer_user until the seven-view sheet also matches those images.',
    inputSchema: parametricArtifactSchema,
    outputSchema: parametricCompileOutputSchema,
  }),
  patch_parametric_components: tool({
    description:
      'Apply a safe local edit to a successful IrisCAD Assembly. Use this only when IrisCAD supplies a Local Patch Workset containing a base_model_revision, editable marked Assembly section(s), and affected component IDs. Replace only supplied existing sections. You may add or delete clearly scoped `part` and `component` sections: additions use complete marked sections, deletions use their exact kind and ID. Do not add/delete helper, parameters, assembly_setup, or assembly_result sections, and never re-order existing sections. Submit no more than 12 total replacement/addition/deletion operations. List every affected component ID, including added or deleted ones, with at most six. A changed shared Part affects every component that uses it. If the user request does not make the target component clear, ask a concise clarification question; do not call this tool or build_parametric_model until the target is clear. Use build_parametric_model instead for a first build, a model artifact, an Assembly-wide restructure, a change affecting more than six components, or any situation without a matching Local Patch Workset. The browser validates and merges the patch before accepting it.',
    inputSchema: patchParametricComponentsSchema,
    outputSchema: parametricCompileOutputSchema,
  }),
  answer_user: tool({
    description:
      'Send the final user-facing chat message. Use for normal non-CAD replies, and after a CAD build only when seven-view review passed (including match to user reference image(s) when present — those images are the true visual target) and intent self-check passed (code matches the user request — features/sizes/constraints; compile success alone is not enough).',
    inputSchema: answerUserSchema,
    outputSchema: answerUserSchema,
  }),
};

export type AppTools = InferUITools<typeof chatTools>;

export type MeshContextData = {
  meshId: string;
  fileType: 'stl';
  filename?: string;
  boundingBox?: { x: number; y: number; z: number };
};

/**
 * Conversation-level signals the server emits as transient stream parts
 * (`writer.write({ transient: true, type: 'data-X', data })`). Transient
 * parts never land in `messages.parts` — they're side-channel updates the
 * client folds straight into the conversation query cache.
 *
 *  * `title-update`    fires once when the server generates a title for
 *    a fresh conversation; client updates `conversations.title`.
 *  * `suggestions-update` fires after each assistant turn finishes;
 *    client updates `conversations.settings.suggestions` so the pills
 *    below the input refresh in lock-step with the response.
 */
export type ConversationTitleUpdate = {
  conversationId: string;
  title: string;
};
export type ConversationSuggestionsUpdate = {
  conversationId: string;
  suggestions: string[];
};

/**
 * Vision-model feature summary shown in chat (plan C dual-channel).
 * `summary` is a short headed plain-text note (not JSON).
 */
export type ReferenceFeaturesData = {
  summary: string;
  modelId: string;
};

export type AppDataTypes = {
  'mesh-context': MeshContextData;
  'title-update': ConversationTitleUpdate;
  'suggestions-update': ConversationSuggestionsUpdate;
  'reference-features': ReferenceFeaturesData;
};

export const meshContextDataSchema = z.object({
  meshId: z.string(),
  fileType: z.literal('stl'),
  filename: z.string().optional(),
  boundingBox: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional(),
});

export type AppUIMessage = UIMessage<
  {
    model?: Model;
    billingTokens?: number;
    // The model's original SimpleCADAPI source for this artifact, captured
    // lazily on the FIRST parameter edit (see `persistParameterEdit`).
    // Parameter edits rewrite the live `tool-build_parametric_model` input
    // code in place, which would otherwise move the derived `defaultValue`
    // to the edited value on every reload. Stashing the original here —
    // message metadata is UI-only and NOT sent to the model by
    // `convertToModelMessages` — lets the client re-derive stable defaults
    // (Reset / slider home / auto range) with no second code copy in the
    // model's context, no migration, and no storage cost on the (common)
    // never-edited artifacts.
    originalCode?: string;
    /** Latest successful compact CAD state; source code remains in `parts`. */
    modelSnapshot?: ParametricModelSnapshot;
  },
  AppDataTypes,
  AppTools
>;

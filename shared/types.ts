import { Database } from './database.ts';
import type { AppUIMessage } from './chatAi.ts';
import type { MateNote } from './assemblyContract.ts';
export type Model = string;

export type Prompt = {
  text?: string;
  images?: string[];
  model?: Model;
};

type MessageRow = Database['public']['Tables']['messages']['Row'];

export type Message = Pick<
  MessageRow,
  'conversation_id' | 'created_at' | 'id' | 'parent_message_id' | 'rating'
> & {
  role: 'user' | 'assistant';
  metadata: AppUIMessage['metadata'];
  parts: AppUIMessage['parts'];
};

export type MeshData = Omit<
  Database['public']['Tables']['meshes']['Row'],
  'prompt'
> & {
  prompt: Prompt;
};

export type ParametricArtifact = {
  title: string;
  version: string;
  code: string;
  /** Historical persisted artifacts omit this at runtime and are treated as `model`. */
  artifact_kind: 'model' | 'assembly';
  /** V1 Assembly intent metadata; it never changes generated geometry. */
  mate_notes?: MateNote[];
  /** Per-component preview state; it never changes the Assembly or its export. */
  assembly_visibility?: Record<string, boolean>;
  /** Set when rebuilding after a successful compile to revise shape. */
  planned_changes?: string;
  /** Short LLM-authored description used by the compact model snapshot. */
  model_summary?: string;
  /** Present only when IrisCAD supplied an approved protected-rebuild workset. */
  protected_rebuild?: ProtectedRebuildContract;
};

export type ProtectedRebuildSection = {
  section_kind:
    | 'parameters'
    | 'helper'
    | 'part'
    | 'assembly_setup'
    | 'component'
    | 'assembly_result';
  section_id: string;
};

export type ProtectedRebuildContract = {
  base_model_revision: string;
  replace_sections: ProtectedRebuildSection[];
  add_sections: ProtectedRebuildSection[];
  affected_component_ids: string[];
  allow_mate_notes_change?: boolean;
};

// label is optional: a parameter annotation can list bare values
// (e.g. `[Assembled, Exploded]`) with no `value:label` pair, in which case
// the parser leaves label undefined and the UI falls back to the value.
export type ParameterOption = { value: string | number; label?: string };

export type ParameterRange = { min?: number; max?: number; step?: number };

export type ParameterType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | 'boolean[]';

export type Parameter = {
  name: string;
  displayName: string;
  value: string | boolean | number | string[] | number[] | boolean[];
  defaultValue: string | boolean | number | string[] | number[] | boolean[];
  // Type should always exist, but old messages don't have it.
  type?: ParameterType;
  description?: string;
  group?: string;
  range?: ParameterRange;
  options?: ParameterOption[];
  maxLength?: number;
};

export type Conversation = Omit<
  Database['public']['Tables']['conversations']['Row'],
  'settings'
> & {
  settings: ConversationSettings;
};

export type GenerationStatus = Database['public']['Enums']['generation-status'];

export type ConversationSettings = {
  model?: Model;
  /**
   * Per-conversation follow-up suggestions rendered as pills above the
   * chat input. Regenerated server-side after each non-tool-call
   * assistant turn — see `emitConversationSuggestions` in
   * `src/server/aiChat.ts`.
   */
  suggestions?: string[];
} | null;

export type Profile = Database['public']['Tables']['profiles']['Row'];

/**
 * MVP plan **1.2** — main-thread RPC thin wrapper around the SimpleCADAPI Worker.
 *
 * Mirror of `toolWorker.ts`: module-singleton Worker, `{id, type, data}` envelope,
 * Promise correlation via pending Map. Chat / download UI should call these
 * helpers only — never `postMessage` directly.
 *
 * Supports: `run_code` / `export_shape` / `render_views` / `render_mesh` /
 * `reset_session` (+ internal `init`).
 */

import {
  SIMPLECADAPI_OCP_WHEEL,
  SIMPLECADAPI_PACKAGE_WHEEL,
  simpleCadWheelCandidateUrls,
} from '@/worker/simpleCadWheels';
import type {
  AssemblyPlacement,
  AssemblyStructure,
} from '@shared/assemblyContract';
import type {
  AssemblySectionAnalysisResult,
  AssemblySectionExecutionFallbackReason,
  AssemblySectionPartialExecutionPlan,
} from '@shared/assemblySectionExecution';

/** Keep in sync with `src/vendor/simplecadapi-webharness/types.mjs`. */
export const SimpleCadMessageType = {
  INIT: 'init',
  RUN_CODE: 'run_code',
  REGISTER_ASSEMBLY_BASELINE: 'register_assembly_baseline',
  RUN_ASSEMBLY_SECTIONS: 'run_assembly_sections',
  ANALYZE_ASSEMBLY_SECTIONS: 'analyze_assembly_sections',
  EXPORT_SHAPE: 'export_shape',
  RENDER_VIEWS: 'render_views',
  RENDER_MESH: 'render_mesh',
  RENDER_ASSEMBLY_COMPONENT_MESHES: 'render_assembly_component_meshes',
  INSPECT_ASSEMBLY_RENDER_STATE: 'inspect_assembly_render_state',
  RENDER_ASSEMBLY_PART_MESHES: 'render_assembly_part_meshes',
  RESET_SESSION: 'reset_session',
  INSPECT_GEOMETRY: 'inspect_geometry',
} as const;

export type SimpleCadMessageType =
  (typeof SimpleCadMessageType)[keyof typeof SimpleCadMessageType];

/** MVP contract final shape handle — see docs/MVP_AGENT_CONTRACT.md */
export const RESULT_SHAPE_NAME = 'result';

/**
 * Interactive 3D preview tessellation (finer than seven-view defaults).
 * Seven-view / RENDER_VIEWS keeps Python defaults 0.35 / 0.22.
 */
export const PREVIEW_MESH_TOLERANCE = 0.12;
export const PREVIEW_MESH_ANGULAR_TOLERANCE = 0.1;

/** Default seven views for vision-model inspection (worker + composite grid). */
export const DEFAULT_INSPECTION_VIEWS = [
  'iso',
  'front',
  'back',
  'top',
  'bottom',
  'left',
  'right',
] as const;

/**
 * Uppercase labels for tool output. Must be members of
 * `parametricCompileSuccessSchema.inspection.views`.
 */
export const DEFAULT_INSPECTION_VIEW_LABELS = [
  'ISO',
  'FRONT',
  'BACK',
  'LEFT',
  'RIGHT',
  'TOP',
  'BOTTOM',
] as const;

export type ErrorGuidance = {
  operation: string | null;
  what_happened: string;
  possible_causes: string[];
  how_to_fix: string[];
  technical_details: string | null;
  signature: string | null;
  documentation_hint: string | null;
};

export type ResultShapeType = 'Solid' | 'Compound' | 'Assembly';

export type RunCodeResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: ErrorGuidance | null;
  shapes: string[];
  result_type: ResultShapeType | null;
  assembly: AssemblyStructure | null;
};

export type AnalyzeAssemblySectionsResult = AssemblySectionAnalysisResult;

export type RunAssemblySectionsResult = RunCodeResult & {
  execution_mode: 'partial' | 'full' | 'partial_then_full_fallback';
  fallback_reason: AssemblySectionExecutionFallbackReason | null;
  executed_sections: AssemblySectionPartialExecutionPlan['sections_to_execute'];
  /** Present only when a partial request safely fell back to a full run. */
  partial_failure_detail?: string;
};

export type ExportShapeResult = {
  ok: boolean;
  path: string;
  size: number;
  error: ErrorGuidance | null;
  /** Present when ok; file bytes from Pyodide virtual FS. */
  bytes?: Uint8Array;
};

export type RenderViewsResult = {
  ok: boolean;
  images: Array<{ view: string; size: number }>;
  /** Present when ok; labeled seven-view composite PNG bytes. */
  composite: Uint8Array | null;
  error: ErrorGuidance | null;
};
/** Packed mesh from Worker `render_mesh` / `renderMeshBuffers` (flat, non-indexed). */
export type RenderTiming = {
  worker_ms: number;
  transfer_ms: number;
  round_trip_ms: number;
};

export type RenderMeshLegendEntry = {
  tag: string;
  label: string;
  color: [number, number, number];
};

export type RenderMeshResult = {
  ok: boolean;
  error: ErrorGuidance | null;
  /** Raw packed buffer; `positions`/`normals`/`colors` are views into this when present. */
  bytes?: Uint8Array;
  positions?: Float32Array;
  normals?: Float32Array;
  colors?: Float32Array;
  bounds?: {
    min: [number, number, number];
    max: [number, number, number];
  };
  legend?: RenderMeshLegendEntry[];
  vertexCount?: number;
  triangleCount?: number;
  path?: string;
  byteLength?: number;
  bufferViews?: Record<
    string,
    { byteOffset: number; byteLength: number; dtype: string; itemSize: number }
  >;
  timing?: RenderTiming;
};
export type RenderAssemblyComponentMeshesResult = {
  ok: boolean;
  error: ErrorGuidance | null;
  components: Array<RenderMeshResult & { component_id: string }>;
};
export type InspectAssemblyRenderStateResult = {
  ok: boolean;
  error: ErrorGuidance | null;
  parts: Array<{
    part_id: string;
    part_name: string | null;
  }>;
  components: Array<{
    component_id: string;
    part_id: string;
    placement: AssemblyPlacement;
  }>;
};
export type RenderAssemblyPartMeshesResult = {
  ok: boolean;
  error: ErrorGuidance | null;
  parts: Array<
    RenderMeshResult & {
      part_id: string;
    }
  >;
  timing?: RenderTiming;
};
export type InspectGeometryResult = {
  ok: boolean;
  volume: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  constraint_report: unknown | null;
  error: ErrorGuidance | null;
};

export type ExportFormat = 'step' | 'stl';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, PendingRequest>();
let workerInstance: Worker | null = null;
let initPromise: Promise<void> | null = null;
/** One Pyodide interpreter — serialize engine calls. */
let queue: Promise<unknown> = Promise.resolve();

function getSimpleCadWorker(): Worker {
  if (workerInstance) return workerInstance;
  workerInstance = new Worker(
    new URL('../vendor/simplecadapi-webharness/worker.mjs', import.meta.url),
    { type: 'module' },
  );
  workerInstance.addEventListener('message', (event: MessageEvent) => {
    const { id, err, data } = event.data ?? {};
    // Unsolicited `{ type: 'ready' }` has no id — ignore.
    if (!id) return;
    const req = pending.get(id);
    if (!req) return;
    pending.delete(id);
    if (err) {
      req.reject(
        new Error(err.message || 'SimpleCADAPI worker operation failed'),
      );
    } else {
      req.resolve(data);
    }
  });
  workerInstance.addEventListener('error', (event) => {
    const err = new Error(event.message || 'SimpleCADAPI worker error');
    pending.forEach((req) => req.reject(err));
    pending.clear();
    workerInstance = null;
    initPromise = null;
  });
  return workerInstance;
}

function nextRequestId(type: string): string {
  return `scad-${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function postRequest<T>(
  type: SimpleCadMessageType | string,
  data: Record<string, unknown>,
): Promise<T> {
  const worker = getSimpleCadWorker();
  const id = nextRequestId(type);
  const responsePromise = new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
  });
  worker.postMessage({ id, type, data });
  return responsePromise;
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Cold-start Pyodide + install wheels (~30–45s). Safe to call repeatedly.
 * Internal to the RPC layer; chat code may call this to warm early.
 */
export function warmupSimpleCadWorker(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = enqueue(async () => {
    await postRequest<{ ok: boolean }>(SimpleCadMessageType.INIT, {
      ocpWheelUrls: simpleCadWheelCandidateUrls(SIMPLECADAPI_OCP_WHEEL),
      simplecadapiWheelUrls: simpleCadWheelCandidateUrls(
        SIMPLECADAPI_PACKAGE_WHEEL,
      ),
    });
  });
  return initPromise;
}

/** Execute SimpleCADAPI Python; returns harness `run_code` JSON (ok/error/shapes). */
export async function runSimpleCadCode(
  code: string,
  sessionId: string,
  artifactVersion?: string,
): Promise<RunCodeResult> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<RunCodeResult>(SimpleCadMessageType.RUN_CODE, {
      code,
      sessionId,
      artifactVersion,
    }),
  );
}

/** Register the version of an Assembly already verified in this Worker session. */
export async function registerSimpleCadAssemblyBaseline(
  sessionId: string,
  artifactVersion: string,
): Promise<{ ok: boolean }> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<{ ok: boolean }>(
      SimpleCadMessageType.REGISTER_ASSEMBLY_BASELINE,
      { sessionId, artifactVersion },
    ),
  );
}

/**
 * Run a planner-approved Assembly subset against its exact live Worker
 * baseline. The Worker itself validates the version and falls back to a clean
 * complete execution; callers must never submit handwritten snippets.
 */
export async function runSimpleCadAssemblySections(
  code: string,
  sessionId: string,
  plan: AssemblySectionPartialExecutionPlan,
): Promise<RunAssemblySectionsResult> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<RunAssemblySectionsResult>(
      SimpleCadMessageType.RUN_ASSEMBLY_SECTIONS,
      {
        code,
        sessionId,
        previousArtifactVersion: plan.previous_successful_artifact_version,
        nextArtifactVersion: plan.next_artifact_version,
        sections: plan.sections_to_execute,
      },
    ),
  );
}

/** Analyze IrisCAD Assembly dependencies without executing Python model code. */
export async function analyzeSimpleCadAssemblySections(
  code: string,
): Promise<AnalyzeAssemblySectionsResult> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<AnalyzeAssemblySectionsResult>(
      SimpleCadMessageType.ANALYZE_ASSEMBLY_SECTIONS,
      { code },
    ),
  );
}

/**
 * Export a named shape from the session namespace to STEP or STL bytes.
 * Default shape name is MVP `result`.
 */
export async function exportSimpleCadShape(
  sessionId: string,
  format: ExportFormat,
  shapeName: string = RESULT_SHAPE_NAME,
  path?: string,
): Promise<ExportShapeResult> {
  await warmupSimpleCadWorker();
  const exportPath = path ?? `/tmp/export_${shapeName}_${sessionId}.${format}`;
  return enqueue(() =>
    postRequest<ExportShapeResult>(SimpleCadMessageType.EXPORT_SHAPE, {
      sessionId,
      shapeName,
      format,
      path: exportPath,
    }),
  );
}

/** MVP 3.1 — export `result` and return a browser Blob (throws on failure). */
export async function exportResultBlob(
  sessionId: string,
  format: ExportFormat,
): Promise<Blob> {
  const result = await exportSimpleCadShape(sessionId, format);
  if (!result.ok || !result.bytes) {
    const detail =
      result.error?.what_happened ??
      result.error?.technical_details ??
      `export_shape(${format}) failed`;
    throw new Error(detail);
  }
  // Copy into a detached buffer so Blob construction is not tied to the
  // Worker's transferred/shared view of the Pyodide FS readback.
  const copy = new Uint8Array(result.bytes.byteLength);
  copy.set(result.bytes);
  const mime = format === 'step' ? 'application/step' : 'model/stl';
  return new Blob([copy], { type: mime });
}

/**
 * Render the default seven orthographic/iso views of `result` and return a
 * single labeled composite PNG (for vision-model inspection feedback).
 */
export async function renderSimpleCadViews(
  sessionId: string,
  shapeName: string = RESULT_SHAPE_NAME,
  views: readonly string[] = DEFAULT_INSPECTION_VIEWS,
): Promise<RenderViewsResult> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<RenderViewsResult>(SimpleCadMessageType.RENDER_VIEWS, {
      sessionId,
      shapeName,
      views: [...views],
      imageSize: 512,
      showAxes: true,
      showEdges: true,
      pathPrefix: `/tmp/${shapeName}_preview`,
    }),
  );
}
export async function renderSimpleCadMesh(
  sessionId: string,
  shapeName: string = RESULT_SHAPE_NAME,
  options: {
    meshTolerance?: number;
    meshAngularTolerance?: number;
    shading?: 'flat' | 'smooth';
  } = {},
): Promise<RenderMeshResult> {
  await warmupSimpleCadWorker();
  return enqueue(async () => {
    const startedAt = performance.now();
    const result = await postRequest<RenderMeshResult>(
      SimpleCadMessageType.RENDER_MESH,
      {
        sessionId,
        shapeName,
        meshTolerance: options.meshTolerance ?? PREVIEW_MESH_TOLERANCE,
        meshAngularTolerance:
          options.meshAngularTolerance ?? PREVIEW_MESH_ANGULAR_TOLERANCE,
        // Interactive preview: per-vertex analytic normals. Seven-view path
        // does not call this helper and stays on Python default flat shading.
        shading: options.shading ?? 'smooth',
      },
    );
    const roundTripMs = performance.now() - startedAt;
    const workerMs = result.timing?.worker_ms ?? 0;
    return {
      ...result,
      timing: {
        worker_ms: workerMs,
        transfer_ms: Math.max(0, roundTripMs - workerMs),
        round_trip_ms: roundTripMs,
      },
    };
  });
}

/** Render each direct Assembly Part instance as a separately controllable mesh. */
export async function renderSimpleCadAssemblyComponentMeshes(
  sessionId: string,
  shapeName: string = RESULT_SHAPE_NAME,
): Promise<RenderAssemblyComponentMeshesResult> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<RenderAssemblyComponentMeshesResult>(
      SimpleCadMessageType.RENDER_ASSEMBLY_COMPONENT_MESHES,
      {
        sessionId,
        shapeName,
        pathPrefix: `/tmp/${shapeName}_assembly_component`,
        meshTolerance: PREVIEW_MESH_TOLERANCE,
        meshAngularTolerance: PREVIEW_MESH_ANGULAR_TOLERANCE,
        shading: 'smooth',
      },
    ),
  );
}

/** Inspect real Part IDs and Component Placements after run_code. */
export async function inspectSimpleCadAssemblyRenderState(
  sessionId: string,
  shapeName: string = RESULT_SHAPE_NAME,
): Promise<InspectAssemblyRenderStateResult> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<InspectAssemblyRenderStateResult>(
      SimpleCadMessageType.INSPECT_ASSEMBLY_RENDER_STATE,
      {
        sessionId,
        shapeName,
      },
    ),
  );
}

/** Tessellate requested unique Parts once in Part-local coordinates. */
export async function renderSimpleCadAssemblyPartMeshes(
  sessionId: string,
  partIds: readonly string[],
  shapeName: string = RESULT_SHAPE_NAME,
): Promise<RenderAssemblyPartMeshesResult> {
  await warmupSimpleCadWorker();
  return enqueue(async () => {
    const startedAt = performance.now();
    const result = await postRequest<RenderAssemblyPartMeshesResult>(
      SimpleCadMessageType.RENDER_ASSEMBLY_PART_MESHES,
      {
        sessionId,
        shapeName,
        partIds: [...partIds],
        pathPrefix: `/tmp/${shapeName}_assembly_part`,
        meshTolerance: PREVIEW_MESH_TOLERANCE,
        meshAngularTolerance: PREVIEW_MESH_ANGULAR_TOLERANCE,
        shading: 'smooth',
      },
    );
    const roundTripMs = performance.now() - startedAt;
    const workerMs = result.timing?.worker_ms ?? 0;
    return {
      ...result,
      timing: {
        worker_ms: workerMs,
        transfer_ms: Math.max(0, roundTripMs - workerMs),
        round_trip_ms: roundTripMs,
      },
    };
  });
}

export async function inspectSimpleCadGeometry(
  sessionId: string,
  shapeName: string = RESULT_SHAPE_NAME,
): Promise<InspectGeometryResult> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<InspectGeometryResult>(SimpleCadMessageType.INSPECT_GEOMETRY, {
      sessionId,
      shapeName,
    }),
  );
}

/** Composite PNG Blob helper (throws if render failed). */
export async function renderResultInspectionBlob(
  sessionId: string,
): Promise<Blob> {
  const result = await renderSimpleCadViews(sessionId);
  if (!result.ok || !result.composite) {
    const detail =
      result.error?.what_happened ??
      result.error?.technical_details ??
      'render_views failed';
    throw new Error(detail);
  }
  const copy = new Uint8Array(result.composite.byteLength);
  copy.set(result.composite);
  return new Blob([copy], { type: 'image/png' });
}

/** Clear the Python namespace for `sessionId` (MVP plan 1.5). */
export async function resetSimpleCadSession(
  sessionId: string,
): Promise<{ ok: boolean }> {
  await warmupSimpleCadWorker();
  return enqueue(() =>
    postRequest<{ ok: boolean }>(SimpleCadMessageType.RESET_SESSION, {
      sessionId,
    }),
  );
}

/** True only for errors that mean the Worker no longer has the executed model. */
export function isSimpleCadWorkerSessionLossError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:worker terminated|worker not initialized|session[^\n]*(?:missing|not found)|result[^\n]*(?:missing|not found)|(?:shape|name)[^\n]*result[^\n]*not found)/i.test(
    message,
  );
}

/**
 * Sessions that have been entered this page lifetime. First enter resets so a
 * brand-new conversation cannot see leftover names from a prior id collision
 * or reused Worker state; re-entering the same id keeps `result` for export.
 */
const enteredSessions = new Set<string>();
/** Coalesce concurrent first-enters (React Strict Mode double-effect, etc.). */
const enterInFlight = new Map<string, Promise<void>>();

/** MVP 1.5 — call when opening a parametric conversation (ChatSession mount). */
export function enterSimpleCadSession(sessionId: string): Promise<void> {
  if (enteredSessions.has(sessionId)) return Promise.resolve();

  const pendingEnter = enterInFlight.get(sessionId);
  if (pendingEnter) return pendingEnter;

  const enterPromise = (async () => {
    await warmupSimpleCadWorker();
    // Re-check after await — another caller may have finished entering.
    if (enteredSessions.has(sessionId)) return;
    // Claim before reset so a concurrent enter cannot schedule a second wipe
    // after run_code has already populated `result`.
    enteredSessions.add(sessionId);
    try {
      await resetSimpleCadSession(sessionId);
    } catch (error) {
      enteredSessions.delete(sessionId);
      throw error;
    }
  })().finally(() => {
    enterInFlight.delete(sessionId);
  });

  enterInFlight.set(sessionId, enterPromise);
  return enterPromise;
}

/**
 * MVP 1.5 — explicit reopen (e.g. Restore version). Always clears the namespace
 * so the next `run_code` cannot see stale variables from the abandoned branch.
 */
export async function reopenSimpleCadSession(sessionId: string): Promise<void> {
  await warmupSimpleCadWorker();
  await resetSimpleCadSession(sessionId);
  enteredSessions.add(sessionId);
}

/** Format a failed `run_code` / export payload for tool `errorText` (plan 1.4 / 2.1). */
export function formatSimpleCadErrorGuidance(
  result: Pick<RunCodeResult, 'error' | 'stdout' | 'stderr'> & {
    ok?: boolean;
  },
): string {
  const parts = ['SimpleCADAPI execution failed.'];
  if (result.error) {
    parts.push('ErrorGuidance (authoritative):');
    parts.push(JSON.stringify(result.error, null, 2));
  }
  if (result.stdout?.trim()) {
    parts.push(`stdout:\n${result.stdout}`);
  }
  if (result.stderr?.trim()) {
    parts.push(`stderr:\n${result.stderr}`);
  }
  if (!result.error && !result.stdout?.trim() && !result.stderr?.trim()) {
    parts.push('No ErrorGuidance, stdout, or stderr was returned.');
  }
  return parts.join('\n\n');
}

export function hasResultShape(shapes: string[]): boolean {
  return shapes.includes(RESULT_SHAPE_NAME);
}

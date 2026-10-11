/**
 * IrisCAD → SimpleCADAPI retrieval sidecar client.
 *
 * Step 2 of the IrisCAD Retrieval Sidecar plan: query assembly + HTTP fetch +
 * mode / timeout / core-only fallback. Wiring into `aiChat` system prompt is
 * Step 3 (`API_RETRIEVAL_MODE=full_index` keeps today's static index).
 */

import type { AppUIMessage, ErrorGuidancePayload } from '@shared/chatAi';
import { getParametricText } from '@shared/parametricParts';
import { env } from './env';
import { logError } from './serverLog';

export type ApiRetrievalMode = 'sidecar' | 'full_index';

export type RetrievalQuery = {
  query: string;
  operation: string | null;
};

export type SidecarSlice = {
  kind: 'sidecar';
  markdown: string;
  hitIds: string[];
  reasons: string[];
  retrieveMode: 'hybrid' | 'core_only';
  /** True when hybrid failed and we served core-only instead. */
  usedCoreFallback: boolean;
  query: string;
  operation: string | null;
};

/** APIs the current IrisCAD Assembly V1 contract must not generate directly. */
export const IRISCAD_V1_GENERATION_EXCLUDED_API_IDS = [
  'translate_model_json_to_freecad_script',
  'translate_model_json_to_fcstd',
  'Assembly',
  'Part',
  'Component',
  'place_component_rassembly',
  'Connector',
  'ConnectorAnchor',
  'ConnectorRef',
  'make_face_connector_rconnector',
  'make_edge_connector_rconnector',
  'make_vertex_connector_rconnector',
  'make_placement_connector_rconnector',
  'add_connector_rpart',
  'add_connector_rassembly',
  'forward_connector_rassembly',
  'make_connector_ref_rconnectorref',
  'Constraint',
  'ConstraintReport',
  'ConstraintResidual',
  'add_fixed_constraint_rassembly',
  'add_revolute_constraint_rassembly',
  'add_prismatic_constraint_rassembly',
  'add_gear_constraint_rassembly',
  'add_belt_constraint_rassembly',
  'add_rack_pinion_constraint_rassembly',
  'solve_assembly_constraints_rassembly',
  'measure_constraint_residual_rconstraintresidual',
  'inspect_assembly_constraints_rconstraintreport',
] as const;

export type FullIndexSlice = {
  kind: 'full_index';
};

export type ParametricApiSlice = SidecarSlice | FullIndexSlice;

const DEFAULT_URL = 'http://127.0.0.1:8765';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_QUERY_CHARS = 1500;
const MAX_USER_TURNS = 3;

export function getApiRetrievalMode(): ApiRetrievalMode {
  const raw = env('API_RETRIEVAL_MODE').trim().toLowerCase();
  if (raw === 'full_index' || raw === 'full-index' || raw === 'static') {
    return 'full_index';
  }
  // Default sidecar so local wiring exercises retrieval; set full_index to
  // revert to the bundled agent-api-index without code changes.
  if (!raw || raw === 'sidecar') {
    return 'sidecar';
  }
  console.warn(
    `[apiRetrieval] unknown API_RETRIEVAL_MODE=${JSON.stringify(raw)}; ` +
      'using sidecar',
  );
  return 'sidecar';
}

function retrievalBaseUrl(): string {
  const raw = env('API_RETRIEVAL_URL').trim();
  return (raw || DEFAULT_URL).replace(/\/$/, '');
}

function retrievalTimeoutMs(): number {
  const raw = env('API_RETRIEVAL_TIMEOUT_MS').trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

let cachedIdentityToken: { value: string; expiresAtMs: number } | null = null;

function jwtExpiresAtMs(token: string): number {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(
      Buffer.from(normalized, 'base64').toString('utf8'),
    ) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function retrievalAuthorizationHeaders(): Promise<
  Record<string, string>
> {
  const audience = retrievalBaseUrl();
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(audience)) {
    return {};
  }

  const now = Date.now();
  if (cachedIdentityToken && cachedIdentityToken.expiresAtMs - now > 60_000) {
    return { Authorization: `Bearer ${cachedIdentityToken.value}` };
  }

  const metadataUrl =
    'http://metadata.google.internal/computeMetadata/v1/instance/' +
    'service-accounts/default/identity?format=full&audience=' +
    encodeURIComponent(audience);
  const response = await fetch(metadataUrl, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!response.ok) {
    throw new Error(
      `failed to obtain Cloud Run identity token (${response.status})`,
    );
  }
  const value = (await response.text()).trim();
  if (!value)
    throw new Error('Cloud Run metadata server returned an empty token');
  cachedIdentityToken = { value, expiresAtMs: jwtExpiresAtMs(value) };
  return { Authorization: `Bearer ${value}` };
}

function extractUserText(message: AppUIMessage): string {
  return getParametricText(message.parts).trim();
}

function isCadMutationToolPart(
  part: AppUIMessage['parts'][number],
): part is AppUIMessage['parts'][number] & {
  type: 'tool-build_parametric_model' | 'tool-patch_parametric_components';
  state: string;
  output?: unknown;
} {
  return (
    part.type === 'tool-build_parametric_model' ||
    part.type === 'tool-patch_parametric_components'
  );
}

/**
 * Latest failed CAD mutation output on the branch (walk from leaf).
 */
export function findLatestBuildErrorGuidance(
  branch: AppUIMessage[],
): ErrorGuidancePayload | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const message = branch[i];
    if (message.role !== 'assistant') continue;
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j];
      if (!isCadMutationToolPart(part)) continue;
      if (part.state !== 'output-available' || part.output == null) continue;
      const output = part.output as {
        status?: string;
        errorGuidance?: ErrorGuidancePayload | null;
      };
      // Only the newest CAD mutation is current. Once a later mutation
      // succeeded, an older ErrorGuidance must not leak into a new edit query.
      if (output.status !== 'error') return null;
      return output.errorGuidance ?? null;
    }
  }
  return null;
}

export type BuildRetrievalQueryOptions = {
  /**
   * Overall + Features from the vision feature summary (plan C). Appended so
   * image-only / vague user text still retrieves relevant CAD APIs.
   */
  visionShapeText?: string | null;
  /** Local-edit prompts need ranked IDs/signatures, not full Markdown bodies. */
  loadBodies?: boolean;
};

/**
 * Build the sidecar query from the conversation branch:
 * recent user texts + optional vision Overall/Features + optional
 * ErrorGuidance fields for repair turns.
 */
export function buildRetrievalQuery(
  branch: AppUIMessage[],
  options: BuildRetrievalQueryOptions = {},
): RetrievalQuery {
  const userTexts: string[] = [];
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (userTexts.length >= MAX_USER_TURNS) break;
    const message = branch[i];
    if (message.role !== 'user') continue;
    const text = extractUserText(message);
    if (text) userTexts.push(text);
  }
  userTexts.reverse();

  const guidance = findLatestBuildErrorGuidance(branch);
  const operation =
    guidance?.operation && guidance.operation.trim()
      ? guidance.operation.trim()
      : null;

  const parts = [...userTexts];
  const visionShapeText = options.visionShapeText?.trim();
  if (visionShapeText) {
    parts.push(`vision shape:\n${visionShapeText}`);
  }
  if (guidance) {
    if (guidance.what_happened?.trim()) {
      parts.push(`error: ${guidance.what_happened.trim()}`);
    }
    if (guidance.documentation_hint?.trim()) {
      parts.push(`docs: ${guidance.documentation_hint.trim()}`);
    }
    if (operation) {
      parts.push(`operation: ${operation}`);
    }
  }

  let query = parts.join('\n').trim();
  if (query.length > MAX_QUERY_CHARS) {
    query = query.slice(query.length - MAX_QUERY_CHARS);
  }
  return { query, operation };
}

type SidecarRetrieveResponse = {
  ok?: boolean;
  mode?: string;
  markdown?: string;
  hit_ids?: string[];
  reasons?: string[];
  error?: string;
};

async function postRetrieve(body: Record<string, unknown>): Promise<{
  markdown: string;
  hitIds: string[];
  reasons: string[];
  retrieveMode: 'hybrid' | 'core_only';
}> {
  const url = `${retrievalBaseUrl()}/retrieve`;
  const timeoutMs = retrievalTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await retrievalAuthorizationHeaders()),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let payload: SidecarRetrieveResponse;
    try {
      payload = (await response.json()) as SidecarRetrieveResponse;
    } catch {
      throw new Error(
        `sidecar returned non-JSON (HTTP ${response.status}) from ${url}`,
      );
    }

    if (!response.ok || payload.ok === false) {
      throw new Error(
        payload.error || `sidecar HTTP ${response.status} from ${url}`,
      );
    }

    const markdown = payload.markdown ?? '';
    if (!markdown.trim()) {
      throw new Error('sidecar returned empty markdown');
    }

    const retrieveMode = payload.mode === 'core_only' ? 'core_only' : 'hybrid';

    return {
      markdown,
      hitIds: Array.isArray(payload.hit_ids) ? payload.hit_ids : [],
      reasons: Array.isArray(payload.reasons) ? payload.reasons : [],
      retrieveMode,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call sidecar `/retrieve`. On hybrid failure, retry BM25-only before the
 * small core pack (never silently fall back to the full static index).
 */
export async function fetchApiPromptSlice(options: {
  query: string;
  operation?: string | null;
  coreOnly?: boolean;
  excludeIds?: readonly string[];
  loadBodies?: boolean;
}): Promise<{
  markdown: string;
  hitIds: string[];
  reasons: string[];
  retrieveMode: 'hybrid' | 'core_only';
  usedCoreFallback: boolean;
}> {
  if (options.coreOnly) {
    const core = await postRetrieve({
      core_only: true,
      load_bodies: options.loadBodies ?? true,
      exclude_ids: options.excludeIds,
    });
    return { ...core, usedCoreFallback: false };
  }

  try {
    const hybrid = await postRetrieve({
      query: options.query,
      operation: options.operation ?? null,
      load_bodies: options.loadBodies ?? true,
      exclude_ids: options.excludeIds,
    });
    return { ...hybrid, usedCoreFallback: false };
  } catch (hybridError) {
    logError(hybridError, {
      functionName: 'api-retrieval',
      statusCode: 502,
      additionalContext: {
        operation: 'hybrid_retrieve_failed',
        queryPreview: options.query.slice(0, 200),
        forcedOperation: options.operation ?? null,
      },
    });

    try {
      const bm25 = await postRetrieve({
        query: options.query,
        operation: options.operation ?? null,
        use_vector: false,
        load_bodies: options.loadBodies ?? true,
        exclude_ids: options.excludeIds,
      });
      console.warn(
        '[apiRetrieval] hybrid retrieve failed; using BM25-only fallback',
        {
          hitIds: bm25.hitIds,
        },
      );
      return { ...bm25, usedCoreFallback: false };
    } catch (bm25Error) {
      logError(bm25Error, {
        functionName: 'api-retrieval',
        statusCode: 502,
        additionalContext: {
          operation: 'bm25_retrieve_failed',
          queryPreview: options.query.slice(0, 200),
          forcedOperation: options.operation ?? null,
        },
      });

      try {
        const core = await postRetrieve({
          core_only: true,
          load_bodies: options.loadBodies ?? true,
          exclude_ids: options.excludeIds,
        });
        console.warn(
          '[apiRetrieval] hybrid and BM25 retrieve failed; using core_only fallback',
          { hitIds: core.hitIds },
        );
        return { ...core, usedCoreFallback: true };
      } catch (coreError) {
        logError(coreError, {
          functionName: 'api-retrieval',
          statusCode: 502,
          additionalContext: {
            operation: 'core_only_fallback_failed',
          },
        });
        throw coreError;
      }
    }
  }
}

/**
 * Resolve what API reference markdown (if any) Step 3 should inject.
 * Non-parametric callers should not call this.
 */
export async function resolveParametricApiSlice(
  branch: AppUIMessage[],
  options: BuildRetrievalQueryOptions = {},
): Promise<ParametricApiSlice> {
  if (getApiRetrievalMode() === 'full_index') {
    return { kind: 'full_index' };
  }

  const { query, operation } = buildRetrievalQuery(branch, options);
  // Empty query (no user text yet) → core pack only via sidecar.
  const slice = query
    ? await fetchApiPromptSlice({
        query,
        operation,
        excludeIds: IRISCAD_V1_GENERATION_EXCLUDED_API_IDS,
        loadBodies: options.loadBodies,
      })
    : await fetchApiPromptSlice({
        query: '',
        coreOnly: true,
        excludeIds: IRISCAD_V1_GENERATION_EXCLUDED_API_IDS,
        loadBodies: options.loadBodies,
      });

  console.info('[apiRetrieval] slice', {
    retrieveMode: slice.retrieveMode,
    usedCoreFallback: slice.usedCoreFallback,
    hitCount: slice.hitIds.length,
    hitIds: slice.hitIds,
    operation,
  });

  return {
    kind: 'sidecar',
    markdown: slice.markdown,
    hitIds: slice.hitIds,
    reasons: slice.reasons,
    retrieveMode: slice.retrieveMode,
    usedCoreFallback: slice.usedCoreFallback,
    query,
    operation,
  };
}

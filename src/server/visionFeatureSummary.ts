import { generateText, type LanguageModel, type LanguageModelUsage } from 'ai';
import type { AppUIMessage } from '@shared/chatAi';
import { env } from './env';

/**
 * Dual-channel image: Gemini only summarizes features;
 * the user-selected model still writes SimpleCADAPI code.
 */
export type ImageCodegenStrategy = 'dual_channel_c';

export const IMAGE_CODEGEN_STRATEGY: ImageCodegenStrategy = 'dual_channel_c';

export const VISION_SUMMARY_MODEL_ID = 'google/gemini-3.1-pro-preview';

/**
 * A/B toggle via `.env.local`:
 * - `VISION_FEATURE_SUMMARY=true` (default if unset): Gemini summary + images
 * - `VISION_FEATURE_SUMMARY=false`: images + text only (skip Gemini summary)
 */
export function isVisionFeatureSummaryEnabled(): boolean {
  const raw = env('VISION_FEATURE_SUMMARY').trim().toLowerCase();
  if (!raw) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  console.warn(
    `[visionFeatureSummary] unknown VISION_FEATURE_SUMMARY=${JSON.stringify(raw)}; ` +
      'defaulting to enabled',
  );
  return true;
}

const SUMMARY_SYSTEM = `You are a CAD vision analyst.
Your only job is to translate visible shape features from the user's reference
photo(s) into plain language a downstream code-generation model can read easily.

Rules:
- Describe only what is visibly present. Do not invent precise millimetre sizes.
- Do not output Python, SimpleCADAPI, JSON, bullet schemas, or any code.
- Do not suggest modeling steps, API names, or build order (no "first shell,
  then cut", no "use fillet/extrude", etc.). Shape description only.
- If the user also provided text, treat sizes/constraints in that text as
  authoritative later — do not override them in this summary.
- Write a short plain-text note (about 8–20 lines). Use exactly these section
  headings, in this order, each on its own line:

Overall:
Symmetry:
Features:
Layout:
Proportions:
Visible dimensions:
Uncertain:

- Under each heading, write 1–3 short sentences (or "none" / "not visible" when empty).
- Put guesses and unclear details only under Uncertain.`;

export type ReferenceImagePayload = {
  mediaType: string;
  dataUrl: string;
};

function referenceImagesFromMessage(
  message: AppUIMessage,
): ReferenceImagePayload[] {
  if (message.role !== 'user') return [];
  return message.parts.flatMap((part) =>
    part.type === 'file' &&
    typeof part.mediaType === 'string' &&
    part.mediaType.startsWith('image/') &&
    typeof part.url === 'string' &&
    part.url.startsWith('data:')
      ? [{ mediaType: part.mediaType, dataUrl: part.url }]
      : [],
  );
}

function userTextFromMessage(message: AppUIMessage): string {
  return message.role === 'user'
    ? message.parts
        .flatMap((part) =>
          part.type === 'text' && typeof part.text === 'string'
            ? [part.text]
            : [],
        )
        .join('\n')
        .trim()
    : '';
}

/** Return images newly supplied on the branch's current user turn. */
export function findCurrentUserReferenceImages(
  messages: AppUIMessage[],
): { images: ReferenceImagePayload[]; userText: string } | null {
  const current = messages.at(-1);
  if (!current || current.role !== 'user') return null;

  const images = referenceImagesFromMessage(current);
  return images.length > 0
    ? { images, userText: userTextFromMessage(current) }
    : null;
}

/** Collect every distinct user reference image in the active branch. */
export function collectBranchReferenceImages(
  messages: AppUIMessage[],
): ReferenceImagePayload[] {
  const seen = new Set<string>();
  return messages.flatMap((message) =>
    referenceImagesFromMessage(message).filter((image) => {
      if (seen.has(image.dataUrl)) return false;
      seen.add(image.dataUrl);
      return true;
    }),
  );
}

/** Reuse the most recently persisted successful vision summary on this branch. */
export function findLatestReferenceFeatureSummary(
  messages: AppUIMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.parts[partIndex];
      if (
        part.type === 'data-reference-features' &&
        typeof part.data?.summary === 'string' &&
        part.data.summary.trim()
      ) {
        return part.data.summary.trim();
      }
    }
  }
  return null;
}

/** Strip accidental markdown fences; keep headed prose as-is. */
function normalizeSummaryText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const fenced = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

const SUMMARY_SECTION_HEADINGS = [
  'Overall',
  'Symmetry',
  'Features',
  'Layout',
  'Proportions',
  'Visible dimensions',
  'Uncertain',
] as const;

function extractSummarySectionBody(
  summary: string,
  section: (typeof SUMMARY_SECTION_HEADINGS)[number],
): string | null {
  const text = summary.trim();
  if (!text) return null;

  const headingAlts = SUMMARY_SECTION_HEADINGS.map((h) =>
    h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|');
  const sectionAlt = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(
    new RegExp(
      `(?:^|\\n)\\s*${sectionAlt}\\s*:\\s*([\\s\\S]*?)(?=(?:\\n\\s*(?:${headingAlts})\\s*:)|$)`,
      'i',
    ),
  );
  if (!match) return null;

  const body = match[1]
    .trim()
    .replace(/^(?:none|n\/a|not visible)\.?$/i, '')
    .trim();
  return body || null;
}

/**
 * Overall + Features from the headed vision summary, for API retrieval only.
 * Shape description — no Layout/Uncertain/build notes.
 */
export function extractRetrievalTextFromSummary(
  summary: string,
): string | null {
  const overall = extractSummarySectionBody(summary, 'Overall');
  const features = extractSummarySectionBody(summary, 'Features');
  const parts = [
    overall ? `overall: ${overall}` : null,
    features ? `features: ${features}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

export function appendReferenceFeatureSummary(
  system: string,
  summary: string,
): string {
  return `${system}

## Reference image feature summary (from vision model)
The following short headed note was extracted by a vision model from the
user reference image(s). Use it together with the actual reference image
file parts still in this conversation.
Priority: explicit sizes/constraints in the user text >
readable dimensions in the image > guesses in this summary.
Treat the Uncertain section as hypotheses, not facts.
Do not skip looking at the reference image itself.

${summary}`;
}

/**
 * Single-shot Gemini feature summary. Returns null on any failure so the
 * codegen path can fall back to image + text only.
 */
export async function summarizeReferenceImages({
  model,
  images,
  userText,
}: {
  model: LanguageModel;
  images: ReferenceImagePayload[];
  userText?: string;
}): Promise<{ summary: string; usage: LanguageModelUsage } | null> {
  if (images.length === 0) return null;

  const textParts = [
    'Describe the attached reference image(s) as a short headed plain-text note ' +
      '(Overall / Symmetry / Features / Layout / Proportions / Visible dimensions / ' +
      'Uncertain). Shape description only — no modeling steps. No JSON.',
    userText?.trim()
      ? `User text (for context only; do not override its sizes later):\n${userText.trim()}`
      : null,
  ].filter(Boolean);

  try {
    const result = await generateText({
      model,
      system: SUMMARY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: textParts.join('\n\n') },
            ...images.map((image) => ({
              type: 'image' as const,
              image: image.dataUrl,
              mediaType: image.mediaType,
            })),
          ],
        },
      ],
      maxOutputTokens: 2048,
    });

    const summary = normalizeSummaryText(result.text);
    if (!summary) return null;

    return { summary, usage: result.usage };
  } catch {
    return null;
  }
}

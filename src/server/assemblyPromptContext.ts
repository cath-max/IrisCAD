import type { AppUIMessage } from '@shared/chatAi';
import {
  asParametricParts,
  getBuildParametricModelArtifact,
} from '@shared/parametricParts';

const ASSEMBLY_INTENT_RE =
  /\b(?:assembly|assembl(?:e|ed|ing)|components?|detachable|removable(?:\s+parts?)?)\b|装配|组件|零部件|可拆卸|可拆|拆卸/i;

function latestUserText(branch: readonly AppUIMessage[]): string {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const message = branch[index];
    if (message.role !== 'user') continue;
    return asParametricParts(message.parts)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

function latestArtifactKind(
  branch: readonly AppUIMessage[],
): 'model' | 'assembly' | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const snapshot = branch[index].metadata?.modelSnapshot;
    if (snapshot) return snapshot.artifactKind;
    const artifact = getBuildParametricModelArtifact(branch[index].parts);
    if (artifact) return artifact.artifact_kind ?? 'model';
  }
  return null;
}

/**
 * Decide whether this turn needs the Assembly V1 fixed API reference package.
 * The decision is deterministic and never calls an additional model.
 */
export function shouldInjectAssemblyV1Reference(
  branch: readonly AppUIMessage[],
): boolean {
  if (ASSEMBLY_INTENT_RE.test(latestUserText(branch))) return true;
  return latestArtifactKind(branch) === 'assembly';
}

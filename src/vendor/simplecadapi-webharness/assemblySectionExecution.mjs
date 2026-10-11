function isAssemblySuccess(result) {
  return result?.ok === true && result.result_type === 'Assembly' && result.assembly != null;
}

/** Execute a preplanned section request while protecting the live namespace. */
export async function executeAssemblySectionRequest({ engine, baselines, data }) {
  const sessionId = data.sessionId ?? 'default';
  const baseline = baselines.get(sessionId);
  let result;
  if (!baseline || baseline !== data.previousArtifactVersion) {
    result = {
      ...(await engine.runCode(data.code, sessionId)),
      execution_mode: 'full',
      fallback_reason: 'worker_baseline_mismatch',
      executed_sections: [],
    };
  } else {
    const partial = await engine.runAssemblySections(data.code, sessionId, data.sections ?? []);
    const inspection = isAssemblySuccess(partial)
      ? await engine.inspectAssemblyRenderState(sessionId, 'result')
      : null;
    if (isAssemblySuccess(partial) && inspection?.ok) {
      result = {
        ...partial,
        execution_mode: 'partial',
        fallback_reason: null,
        executed_sections: data.sections ?? [],
      };
    } else {
      const partialFailureDetail = !partial?.ok
        ? partial?.error?.what_happened ?? partial?.error?.technical_details ?? 'Partial section execution failed.'
        : !isAssemblySuccess(partial)
          ? 'Partial section execution did not produce an Assembly result.'
          : inspection?.error?.what_happened ?? inspection?.error?.technical_details ?? 'Partial Assembly inspection failed.';
      await engine.resetSession(sessionId);
      const fallback = await engine.runCode(data.code, sessionId);
      result = {
        ...fallback,
        execution_mode: 'partial_then_full_fallback',
        fallback_reason: 'partial_execution_failed',
        executed_sections: [],
        partial_failure_detail: partialFailureDetail,
      };
      if (!isAssemblySuccess(fallback)) await engine.resetSession(sessionId);
    }
  }
  if (isAssemblySuccess(result)) baselines.set(sessionId, data.nextArtifactVersion);
  else baselines.delete(sessionId);
  return result;
}

export { isAssemblySuccess };

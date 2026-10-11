# Related API Retrieval Scoring Plan

## Goal

Extend SimpleCADAPI hybrid retrieval so a relevant consumer API can bring in the most prompt-relevant APIs that produce its required geometry inputs. Reuse the existing BM25/vector score; do not add another LLM call or embedding request.

The implementation must preserve these invariants:

- Final hybrid output remains exactly 20 APIs.
- The six core APIs are always retained: `make_box_rsolid`, `make_cylinder_rsolid`, `union_rsolid`, `cut_rsolid`, `extrude_rsolid`, and `revolve_rsolid`.
- Fixed core membership alone must not trigger related-API expansion.
- Expansion adds at most 4 APIs, follows at most 2 dependency levels, detects cycles, and never duplicates an API.
- Existing low-priority demotion and forced `operation` behavior remain effective.

```mermaid
flowchart LR
    query[UserQuery] --> scoring["BM25 + Vector Scoring"]
    scoring --> baseScores[BaseScores]
    baseScores --> seeds[RelevantSeedAPIs]
    seeds --> inputRoles[RequiredInputRoles]
    inputRoles --> producerIndex[ProducerIndex]
    producerIndex --> relatedScore[RelatedAPIScoring]
    baseScores --> relatedScore
    relatedScore --> expanded[ExpandedRankedCandidates]
    expanded --> merge["Core + Ranked Merge"]
    merge --> top20[FinalTop20]
```

## Implementation Tasks

### 1. Freeze the current retrieval contract

**Work**

- Move the assertions from `D:/python_project/SimpleCADAPI-repo/scripts/check_retrieval_core_merge.py` into pytest coverage under `test/test_retrieval_merge.py`.
- Assert the exact six-core set, final length 20, score ordering, forced-operation behavior, and the rule that only non-core results may be evicted.
- Record baseline rankings with related expansion disabled.

**Purpose**

Prevent the new layer from silently breaking current core and Top-20 guarantees.

### 2. Parse signatures into geometry input/output metadata

**Depends on:** Task 1

**Work**

- Add a reusable parser in `src/simplecadapi/retrieval/signature_types.py`.
- Extend `scripts/build_api_catalog.py` to emit normalized `input_types` and `return_types`.
- Expand `Union`, `List`, and `Sequence` while ignoring scalar/configuration types.
- Treat `Vertex`, `Edge`, `Wire`, `Face`, `Solid`, `Compound`, and `ShapeSelector` as expandable geometry types.
- Do not include the new fields in BM25 or embedding text.

**Purpose**

Turn signatures such as `sweep_rsolid(profile: Face, path: Wire) -> Solid` into deterministic machine-readable dependencies.

### 3. Build a producer index once at sidecar startup

**Depends on:** Task 2

**Work**

- Add `src/simplecadapi/retrieval/producer_index.py`.
- Build `geometry_type -> producer API ids` in `ApiRetriever.__init__` in `src/simplecadapi/retrieval/retrieve.py`.
- Validate that every configured related API exists in the catalog.
- Cache the index for all requests.

**Purpose**

Make per-query producer lookup an in-memory dictionary operation rather than reparsing 165 signatures or Markdown files.

### 4. Define semantic input roles and initial relationship weights

**Depends on:** Tasks 2–3

**Work**

- Add `src/simplecadapi/retrieval/relations.py`.
- Define roles that raw types cannot distinguish:
  - `sweep_rsolid`: `profile: Face`, `path: Wire`
  - `loft_rsolid`: `profiles: Wire`, select two producers where appropriate
  - `extrude_rsolid` and `revolve_rsolid`: `profile: Wire | Face`
  - `helical_sweep_rsolid`: `profile: Wire`
  - `make_wire_from_edges_rwire`: `edges: Edge`
  - face-from-wire APIs: closed profile `Wire`
- Seed the first high-confidence producer weights:
  - Sweep path: spline wire `1.00`, three-point arc `0.80`, angle arc `0.75`, polyline `0.45`
  - Sweep profile: rectangle face `1.00`, circle face `0.90`, face-from-wire `0.65`
  - `make_spline_redge` → `make_wire_from_edges_rwire`
  - fillet/chamfer → `select_edges_by_tag`
  - shell → `select_faces_by_tag`

**Purpose**

Allow prompt relevance to choose between semantically different producers of the same type, such as rectangular blade profiles and circular pipe profiles.

### 5. Implement related-API scoring without new network calls

**Depends on:** Task 4

**Work**

- Add `src/simplecadapi/retrieval/related_score.py`.
- Reuse the score array already produced by `ApiRetriever.score_query`.
- Start with:

```text
related_score(producer)
  = query_score(producer)
  + propagation_weight * query_score(seed) * relation_weight
```

- Start `propagation_weight` at `0.20` and tune only through golden-query tests.
- Preserve the existing low-priority penalty; relationships must not bypass it.

**Purpose**

Combine direct prompt relevance, seed relevance, and engineering compatibility without a second embedding or LLM call.

### 6. Gate which APIs may trigger expansion

**Depends on:** Task 5

**Work**

- Add seed activation logic in `src/simplecadapi/retrieval/expand.py`.
- Allow relevant non-core ranked APIs and forced operations to trigger.
- Allow a core API to trigger only when its original query score passes a threshold; start with `0.20`.
- Do not trigger solely because an API is present in the fixed core pack.

**Purpose**

Prevent `extrude_rsolid` and `revolve_rsolid` from injecting profile helpers into every query.

### 7. Expand dependencies under strict depth and budget controls

**Depends on:** Task 6

**Work**

- Implement the expansion traversal in `expand.py`.
- Select one producer per input role; allow two distinct Wire producers for loft profiles.
- Prefer a direct producer such as `make_spline_rwire` over `make_spline_redge` plus a converter.
- Set initial limits to 4 added APIs and depth 2.
- Add deduplication and cycle detection.

**Purpose**

Produce a usable workflow while preventing dependency explosion and prompt dilution.

### 8. Integrate expansion before the existing core merge

**Depends on:** Task 7

**Work**

- Insert expansion in `ApiRetriever.retrieve` after scoring/ranking and forced-operation insertion, but before `merge_core_and_ranked`.
- Insert related candidates into the ranked stream using their related scores.
- Let the existing merge retain core and evict the lowest-scoring ordinary non-core candidates.
- Keep the final ordering score-based.

**Purpose**

Fit related APIs inside the existing 20-result budget instead of appending more prompt content.

### 9. Add reasons and diagnostics

**Depends on:** Task 8

**Work**

- Extend `ApiHit.reason` in `src/simplecadapi/retrieval/types.py` with values such as:
  - `related:sweep_rsolid:path`
  - `related:sweep_rsolid:profile`
  - `type_producer:Wire`
- Preserve the reason list in CLI and sidecar responses.
- Add optional verbose diagnostics for seed score, producer base score, relation weight, final score, insertion, and eviction.

**Purpose**

Make every automatically added API explainable and make ranking failures diagnosable.

### 10. Add deterministic unit and golden-query tests

**Depends on:** Tasks 2–9

**Work**

- Add:
  - `test/test_retrieval_signature_types.py`
  - `test/test_retrieval_producer_index.py`
  - `test/test_retrieval_related_score.py`
  - `test/test_retrieval_expansion.py`
  - `test/test_retrieval_golden_queries.py`
  - `test/fixtures/retrieval/golden_queries.json`
- Test parsing, producer lookup, scores, thresholds, budget, depth, cycles, deduplication, core preservation, forced operations, low-priority handling, and exact Top-20 output.
- Add golden cases:
  - Impeller: sweep + spline wire + rectangle face + radial pattern
  - Curved pipe: sweep + spline wire + circle face
  - Loft transition: loft + appropriate Wire profiles
  - Fillet/chamfer: edge selector companion
  - Shell: face selector companion
  - Negative control: “cut a hole” must not pull spline/profile helpers
- Use BM25-only or fixed/precomputed query vectors. Tests must never call a live embedding API or LLM.

**Purpose**

Prove that the system selects complete, prompt-appropriate API workflows and does not pollute unrelated queries.

### 11. Benchmark the expansion layer offline

**Depends on:** Task 10

**Work**

- Add `scripts/bench_api_retrieval_offline.py`.
- Warm one `ApiRetriever`, run a fixed query set repeatedly, and separately time scoring, expansion, merge, and body loading.
- Benchmark BM25-only and precomputed query-vector paths.
- Report p50 and p95; do not use live embedding or LLM calls.
- Target expansion p95 below 5–10 ms on a warm process.

**Purpose**

Verify that the new in-memory lookup and scoring are negligible compared with embedding network latency and Markdown body loading.

### 12. Add rollout control and documentation

**Depends on:** Tasks 10–11

**Work**

- Add `RELATED_API_EXPANSION=true|false`, initially allowing quick rollback and A/B comparison.
- Document the pipeline, scoring formula, thresholds, limits, reason fields, testing commands, and sidecar restart requirement in `retrieval/README.md`.
- Update `docs/MVP_AGENT_CONTRACT.md` to state that related expansion remains deterministic and does not invoke an additional model.
- Enable by default only after golden tests, benchmark, and a real CADAM impeller run pass.

**Purpose**

Ship safely and preserve an immediate fallback if ranking regressions appear.

## Final Acceptance Criteria

- Exactly six core APIs and exactly 20 final APIs.
- No extra LLM or embedding request.
- Maximum 4 related APIs and depth 2.
- Fixed core membership alone never triggers expansion.
- Impeller retrieval includes `sweep_rsolid`, `make_spline_rwire`, `make_rectangle_rface`, and `radial_pattern_rsolidlist`.
- Curved pipe selects a circular profile instead of a rectangular profile.
- Unrelated boolean queries receive no spline/profile expansion.
- Reasons identify the seed and role for every related API.
- Expansion overhead remains in the low-millisecond range.

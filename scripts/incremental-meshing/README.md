# Assembly incremental meshing — geometry fingerprint Spike

This Spike validates a browser-side Part geometry fingerprint against CADAM's
real vendored OCP.wasm and SimpleCADAPI wheels. It does not change production
Worker, mesh, or preview contracts.

## Environment

- OCP.wasm: `7.9.3.1.post202607021200`
- SimpleCADAPI: `2.0.1b6`
- Mesh tolerance: `0.12`
- Mesh angular tolerance: `0.1`
- Browser used for the recorded run: Microsoft Edge `151.0.4129.93`

## Reproduction

From `D:\agent_project\my-cadam-1`:

```powershell
node scripts/latency/serve-cad-bench.mjs 8745
```

Then open these pages in order:

1. `http://localhost:8745/scripts/incremental-meshing/fingerprint-spike-runner.html`
2. `http://localhost:8745/scripts/incremental-meshing/fingerprint-post-mesh-spike.html`
3. `http://localhost:8745/scripts/incremental-meshing/fingerprint-clean-first-spike.html`

Each page stores its JSON result on `window.__FINGERPRINT_SPIKE__` and renders
the same JSON into the page.

`fingerprint-spike.html` contains the original candidate experiment. It
deliberately calls `TopoDS_Shape.HashCode` and records why that desktop-OCP
candidate fails in OCP.wasm. `fingerprint-spike-runner.html` repeats the same
cases with capability detection so the remaining candidates can complete.

## Recorded results

### `HashCode` is unavailable

`TopoDS_Solid` in the vendored OCP.wasm wheel does not expose `HashCode`.
Existing desktop-OCP code that calls `shape.HashCode(...)` cannot be reused for
the browser fingerprint.

### Serialized B-Rep SHA-256 distinguishes geometry

Across three fresh Worker sessions:

- A `40 x 30 x 10` box always produced
  `1d0676d4dfa20e2ba17c8c24880d9a0f9f1c18a45d1144a0fcc79fe3f6fba389`.
- A separately constructed box with the same dimensions produced the same
  digest. The cache must still include `part_id`, per the product decision, so
  different Part definitions do not share a cache entry.
- Changing only the width to `44` produced
  `c78b894e11110f4aa19a58ee059b24c4f03185b9fa8d1094ec1cf257b9b758d0`.
- Two Components that reuse one Part retained the same Part and body object;
  their different Placements did not change the local body digest.

### Triangulation must be removed before serialization

`BRepTools.Write_s` includes triangulation state. For a 12-hole perforated
plate, the digest and byte length changed after tessellation:

| State                     | B-Rep bytes | SHA-256                                                            |
| ------------------------- | ----------: | ------------------------------------------------------------------ |
| Before explicit clean     |   1,200,664 | `b5d57aa48f927ab5701f8ed0741985ad40498b79efed43d3691f3827ea124c82` |
| After tessellation        |   1,514,786 | `2f50913bdab83eff514c9f1e12fb7200cfe2033f2d4ca3a2452448e4870f6e82` |
| After `BRepTools.Clean_s` |     937,277 | `e6dd12bdf77c935f30f89c14a05b3b32d1dd38e4ecc017044e6887c02d0fd0a7` |

When the body was cleaned before the first serialization and cleaned again
after tessellation, both serializations produced the same 937,277-byte payload
and the same digest. The measured clean calls took approximately `0.2 ms` and
`0.1 ms` in that run.

Therefore the fingerprint operation must clean triangulation before writing the
local B-Rep. Cleaning removes cached tessellation, not the Part's B-Rep geometry;
the Part is tessellated afterward only when its cache entry misses.

### Measured cost

These are measured values from this machine, not product-wide estimates:

- Box B-Rep write/read/SHA-256 median: `1.6 ms`, `0.7 ms`, and `0.4 ms` across
  the three runs. Warm box tessellation medians were `8.8 ms`, `5.7 ms`, and
  `6.1 ms`.
- Perforated-plate B-Rep write/read/SHA-256 medians before explicit clean were
  `56.1 ms`, `42.6 ms`, and `41.7 ms`. Warm tessellation medians were
  `196.2 ms`, `200.2 ms`, and `181.3 ms` for 6,108 triangles.
- The clean-first focused run measured `30.3 ms` for the cleaned B-Rep
  write/read/SHA-256 and `1,700.5 ms` for that run's first tessellation. Cold
  initialization and first-tessellation overhead should not be compared with a
  warm interaction.
- The main three-run page took `22,894.8 ms` total including OCP/Pyodide startup;
  the individual run wall times were `4,434.2 ms`, `2,527.6 ms`, and
  `2,512.8 ms`.

Serialization hashing is materially cheaper than tessellation for the tested
complex Part, but it is not free and should run once per unique `part_id` per
completed script execution.

### Placement fingerprint

`Placement.to_dict()` exposes the complete local-to-parent frame:

- `origin`
- `x_axis`
- `y_axis`
- `z_axis`

The moved-and-rotated test changed the Placement SHA-256 while leaving the
shared Part body unchanged. OCP can emit `-0.0` in derived axes, so all zero
values must be normalized to `0.0` before canonical JSON serialization. The
normalized frame can also be converted directly to a Three.js 4x4 matrix.

## Recommended contract for the next plan item

Use this in-memory Part mesh cache key:

```text
part_id + sha256(cleaned local B-Rep serialization) + meshing_settings_version
```

Use a separate Placement fingerprint computed from canonical JSON containing
the normalized `origin`, `x_axis`, `y_axis`, and `z_axis` values.

Different `part_id` values never share a cache entry, even if their B-Rep
digests match. Components with the same `part_id` share one local Part mesh and
retain independent Placement and visibility state.

If `Clean_s`, `Write_s`, file read, SHA-256, Placement extraction, or the
Part/Component mapping fails, mark fingerprinting unavailable for that result
and use the full-mesh fallback. Do not reuse a prior mesh on partial evidence.

## Not yet validated

- Digest stability across browser restarts, a different browser engine, or an
  OCP/SimpleCADAPI upgrade. Persistent cache keys must include implementation
  versions and require separate validation.
- Very large production Parts, unusual topology, and nondeterministic modeling
  algorithms may have different serialization costs or stability behavior.
- This Spike does not implement the cache, change classification, local Part
  tessellation, Three.js matrix updates, or GPU reference counting.

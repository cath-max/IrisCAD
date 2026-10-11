# Latency Bench — LLM + CAD

Two **independent** timers for “which stage is slowest in a full parametric turn.”
They do **not** run real Pyodide inside the LLM script, and do **not** call the chat API from the CAD page. Compare the two JSON reports side by side.

## Stage names (fixed)

| Suite | Stages                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| LLM   | `ttfb` · `thinking` · `tool_input_build_parametric_model` · `round_gap` · `answer_user` · `llm_round_total` |
| CAD   | `init` · `run_code` · `render_views` · `render_mesh` · `export_stl` · `export_step`                         |

Shared report shape:

```json
{
  "suite": "llm",
  "total_ms": 12345,
  "warm": false,
  "stages": [{ "name": "thinking", "ms": 2100 }]
}
```

## Prerequisites

1. Wheels (CAD bench):

   ```bash
   node scripts/setup-simplecadapi-vendor.mjs
   ```

2. Local CADAM app (LLM bench): `npm run dev` (default `http://localhost:3000`), Supabase + billing + provider keys in `.env.local`.

3. Auth for LLM bench — either:
   - `LATENCY_ACCESS_TOKEN=<supabase user jwt>`
   - or `LATENCY_EMAIL` + `LATENCY_PASSWORD` (script signs in via Supabase Auth)

## CAD bench (browser)

```bash
node scripts/latency/serve-cad-bench.mjs
# open http://localhost:8744/scripts/latency/cad-bench.html
```

The page auto-runs: `init` → `run_code` (40 mm cube with `result`) → `render_views` → `render_mesh` → STL/STEP export.

- Results: on-page table, `console.table`, `window.__BENCH__`
- Click **Download JSON** to save `cad-latency.json`
- First load includes cold Pyodide/`init` (~30–45 s). Reload and click **Run again** for a warm run (`warm: true` if you skip re-init — the page labels cold vs warm).

## LLM bench (Node)

```bash
# from CADAM root; app must already be running
node scripts/latency/llm-bench.mjs --out llm-latency.json

# options
node scripts/latency/llm-bench.mjs \
  --prompt "a 40mm cube" \
  --model anthropic/claude-sonnet-5 \
  --max-rounds 6 \
  --app-url http://localhost:3000 \
  --out llm-latency.json
```

Env (optional overrides; also reads `.env.local` for Supabase):

| Variable                                       | Meaning                                      |
| ---------------------------------------------- | -------------------------------------------- |
| `LATENCY_APP_URL`                              | App origin (default `http://localhost:3000`) |
| `LATENCY_ACCESS_TOKEN`                         | User JWT                                     |
| `LATENCY_EMAIL` / `LATENCY_PASSWORD`           | Sign-in if no token                          |
| `LATENCY_MODEL`                                | Default model id                             |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | From `.env.local`                            |

Behavior:

1. Creates a parametric conversation + user message.
2. `POST /api/parametric-chat`, parses UI-message SSE stages.
3. On `build_parametric_model` **stubs** a successful tool output in DB (no Pyodide).
4. Continues until `answer_user` or `--max-rounds`.

## Comparing reports (bottleneck)

1. Run CAD bench → save `cad-latency.json`.
2. Run LLM bench with a similar prompt → save `llm-latency.json`.
3. Merge mentally or with a one-liner:

```bash
node -e "const L=require('./llm-latency.json');const C=require('./cad-latency.json');console.table([...L.stages.map(s=>({suite:'llm',...s})),...C.stages.map(s=>({suite:'cad',...s}))].sort((a,b)=>b.ms-a.ms))"
```

Example interpretation:

| Stage                               | Suite | ms    | Notes                                |
| ----------------------------------- | ----- | ----- | ------------------------------------ |
| `init`                              | cad   | 35000 | Cold start only — ignore for warm UX |
| `tool_input_build_parametric_model` | llm   | 12000 | Writing Python for the tool          |
| `thinking`                          | llm   | 8000  | Reasoning before/around tools        |
| `render_views`                      | cad   | 4500  | Seven-view sheet in the agent loop   |
| `run_code`                          | cad   | 1800  | Execute artifact                     |
| `render_mesh`                       | cad   | 1200  | Interactive 3D preview               |
| `round_gap` + later LLM rounds      | llm   | …     | Multi-round agent loop               |

**Rule of thumb:** sort all stages by `ms` (exclude cold `init` when optimizing warm turns). The largest remaining row is the primary UX target.

### Sample commands (smoke)

```bash
# CAD (browser)
node scripts/setup-simplecadapi-vendor.mjs   # once
node scripts/latency/serve-cad-bench.mjs
# open http://localhost:8744/scripts/latency/cad-bench.html → Download JSON

# LLM (app must be up: npm run dev)
# PowerShell example:
$env:LATENCY_EMAIL="you@example.com"
$env:LATENCY_PASSWORD="..."
node scripts/latency/llm-bench.mjs --prompt "a 40mm cube" --out llm-latency.json
```

Both reports use the same `{ suite, total_ms, stages:[{name,ms}] }` shape so you can diff without opening the app.

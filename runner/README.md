# Experiment Runner

Plain-ESM CLI that orchestrates the GLM harness over the fixed `SPEC.md` in isolated workspaces.

## Usage

```bash
node runner/run-experiment.mjs --config c1|c2|c3 [options]
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--config c1\|c2\|c3` | **required** | Experiment configuration |
| `--runs-dir <path>` | `experiment/runs` | Run workspace root |
| `--spec <path>` | `experiment/SPEC.md` | Fixed specification file |
| `--task-file <path>` | — | Override generation task (cheap validation runs) |
| `--max-turns <n>` | 8 | Loop budget (C2/C3 nodes) |
| `--max-steps <n>` | 12 | Graph step budget (C3 only) |
| `--tool-rounds <n>` | 80 (c1), 30 (c2/c3) | Tool-call budget per interaction |
| `--verify-cmd <cmd>` | `docker compose up -d --build && curl -sf http://localhost:3000/health` | C2 verification command |
| `--with-batteries` | off | After generation, start the stack and run acceptance batteries |
| `--keep` | off | With `--with-batteries`, do **not** tear the stack down |
| `--dry-run` | off | Print the plan JSON and exit without calling the model |
| `--harness-config <path>` | — | JSON `{ mcpServers, skillsDirs }`; wires MCP tools + skills into every harness the run builds |

### Credentials

`MODEL_API_KEY` and `MODEL_ID` are read from `process.env`, falling back to `glm/.env` (simple `key=value` parse). A clear error is raised if both are missing.

### Tests

`node --test runner/run-experiment.test.mjs` (Node's built-in test runner; no extra dependency). Covers the `--harness-config` wiring against glm's fixture MCP server + skill fixtures: `run-report.json`'s `harnessConfig` metadata, the guardrail allowlist extended with MCP tools + `load_skill`, the MCP provider being closed when skill loading fails, and that a run without `--harness-config` registers the same tool set as before. Also covers `createModel()` (returns a plain `GlmModelAdapter` without a router, wraps it in a `RoutingModelAdapter` with the configured routes using an injected `makeAdapter` stub — no network — when one is configured, and propagates a clear missing-env-var error) and `summarizeRouting()` (decision log → counts per route/reason). `run-experiment.mjs` only runs `main()` when executed directly (`node runner/run-experiment.mjs ...`), so importing it for tests has no side effects.

## Configurations

- **c1** — Single `Harness.run(task)` interaction. No verification, no retry. Fastest, weakest.
- **c2** — `AgentLoop` with corrective turns. Each turn runs the harness, then the verification command decides FINISH / RETRY / FAIL.
- **c3** — `GraphEngine` with a 5-node fixed topology and a custom router.

### C3 topology

| Node | Role | Task essence | Verification |
|------|------|--------------|--------------|
| architect | architect | Write `docs/architecture.md` | `test -f docs/architecture.md` |
| data | data | Implement data layer (migrations + seed) | none |
| backend | backend | Implement NestJS backend (EP-01..EP-20) | none |
| frontend | frontend | Implement React SPA (SCR-01..SCR-08) | none |
| reviewer | reviewer | Review system, write `review-verdict.json` | `test -f review-verdict.json` |

Router:
- Non-reviewer nodes flow linearly: architect → data → backend → frontend → reviewer.
- A failed node is retried once (same node), then the graph fails.
- After reviewer: `acceptable: true` → FINISH; `responsible: X` → NEXT X; otherwise retry reviewer once, then FAIL.

## MCP tools and skills (`--harness-config`)

A JSON config (see `glm/examples/harness-config.json`) can add MCP tools
and agent skills identically to C1, C2 and C3:

```json
{
  "mcpServers": { "name": { "command": "...", "args": [], "env": {}, "cwd": "." } },
  "skillsDirs": ["./skills"]
}
```

The runner loads it once per run: one MCP connection (`McpToolProvider`)
is opened and shared across every harness the run builds (C3 builds one
per graph node), and one `SkillCatalog` is loaded once. Each harness's
tool manager gets the same MCP tools plus `load_skill` registered into it,
and the guardrail `allowedTools` list is extended with those tool names —
so guardrails and the audit log apply to MCP/skill calls exactly like the
built-in tools. The connection is always closed at the end of the run
(`finally`), even on failure; a failure while closing it is logged and
recorded under `run-report.json`'s `closeError` field without replacing
the run's own failure. Without `--harness-config`, none of this runs and
output is unchanged.

A missing/invalid config file, a server that fails to connect, or a
skills directory that fails to load are recorded like any other run
failure: `run-report.json` is still written, with `status: "FAILED"` and
`failure: "harness-config: <message>"`, and the process exits non-zero.
`--harness-config` with no path value is a usage error (matching
`--config`), not a raw stack trace.

## Model router (`--harness-config` with a `router` section)

The same `--harness-config` file can also carry an optional `router`
section (see `glm/docs/model-router.md`). It is **not** set in this
repo's own `experiment/harness-config.json` — routing stays off by
default — but a config that opts in looks like:

```json
{
  "skillsDirs": ["./skills"],
  "router": {
    "longContextThreshold": 60000,
    "routes": {
      "longContext": { "model": "glm-5.2-long", "apiKeyEnv": "LONG_MODEL_API_KEY" },
      "retry": { "model": "glm-5.2" }
    }
  }
}
```

When set, the runner wraps the model it builds for the run in a
`RoutingModelAdapter` — identically for c1, c2 and c3, using the same
`sessionId` — so requests over `longContextThreshold` go to `longContext`,
retry turns (verification feedback present) go to `retry`, and everything
else keeps going to the default model. Without a `router` section (or
without `--harness-config` at all), the model is unwrapped and behavior
is unchanged.

## Metrics recorded — `routing`

When a router is active, `run-report.json` gains a `routing` field:

```json
{
  "routing": {
    "byRoute": { "default": { "calls": 3, "promptTokens": 120, "completionTokens": 60, "totalTokens": 180, "cost": 0.01 } },
    "decisions": { "default:default": 3, "longContext:long_context": 1 }
  }
}
```

`byRoute` is the per-route usage from `RoutingModelAdapter.getRouting()`.
`decisions` is the route-decision log collapsed into counts per
`"<route>:<reason>"` key rather than the full per-call list, which would
otherwise grow unbounded over a long C2/C3 run; per-route/per-reason
counts are enough to see which rule fired and how often. `harnessConfig`
metadata also gains a `routeNames` array (`["default", ...]`) when a
router is configured.

## Battery phase (`--with-batteries`)

1. `docker compose up -d --build` in the workspace.
2. Poll `GET http://localhost:3000/health` up to 120 s.
3. Run `node ../acceptance/run-all.mjs` with the required environment.
4. Save the aggregated report as `batteries-report.json` in the workspace.
5. `docker compose down -v` (unless `--keep`).

> **Warning:** Ports 5432, 3000 and 8080 are fixed. Run one experiment at a time; concurrent runs will conflict.

## Metrics recorded

Every run writes `run-report.json` into the workspace:

```json
{
  "config": "c1|c2|c3",
  "model": "glm-5.2",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 0,
  "status": "SUCCESS|FAILED",
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "calls": 0 },
  "turns": 0,
  "steps?": 0,
  "totalLoopTurns?": 0,
  "decision?": {},
  "failure?": "...",
  "trace": [...],
  "harnessConfig?": {
    "path": "...",
    "sha256": "...",
    "mcpServers": ["..."],
    "toolNames": ["mcp__server__tool", "load_skill"],
    "skillNames": ["..."],
    "routeNames?": ["default", "longContext", "retry"]
  },
  "routing?": {
    "byRoute": { "default": { "calls": 0, "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "cost": 0 } },
    "decisions": { "default:default": 0 }
  },
  "closeError?": "..."
}
```

- `turns` — interaction turns (C1/C2) or per-node loop turns aggregated (C3).
- `steps` — graph steps (C3 only).
- `totalLoopTurns` — total loop turns across all nodes (C3 only).
- `trace` — compact per-turn/per-step summaries; no full model content.
- `harnessConfig` — only present with `--harness-config`: the config path,
  a sha256 of its content, the configured MCP server names, every
  registered tool name (MCP + `load_skill`), every loaded skill name, and
  (only when `router` is configured) `routeNames` — `["default", ...]`.
  A failure loading/connecting it is recorded as `status: "FAILED"` and
  `failure: "harness-config: ..."` instead (see above).
- `routing` — only present when a `router` section is configured; see
  "Model router" above.
- `closeError` — only present if closing the MCP connection at the end of
  the run itself failed; never replaces `failure`.

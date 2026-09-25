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
| `--runs-dir <path>` | `<app>/runs` | Run workspace root |
| `--spec <path>` | `app/SPEC.md` | Fixed specification file |
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
(`finally`), even on failure. Without `--harness-config`, none of this
runs and output is unchanged.

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
    "skillNames": ["..."]
  }
}
```

- `turns` — interaction turns (C1/C2) or per-node loop turns aggregated (C3).
- `steps` — graph steps (C3 only).
- `totalLoopTurns` — total loop turns across all nodes (C3 only).
- `trace` — compact per-turn/per-step summaries; no full model content.
- `harnessConfig` — only present with `--harness-config`: the config path,
  a sha256 of its content, the configured MCP server names, every
  registered tool name (MCP + `load_skill`), and every loaded skill name.

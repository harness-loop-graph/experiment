# Experiment — Medical Appointments & Clinical History

This repository is the **experiment bench**, not an application. It holds
the fixed specification the generator system receives (`SPEC.md`), the
hidden acceptance batteries (defined before the first run, never shown
to the generator), and the experiment runner. The only thing that
generates code is the harness (`../glm/`).

Generated systems do not live here: each run builds in an isolated
workspace under `runs/` (gitignored), and the batteries run against
that workspace.

## Contents

- `SPEC.md` — fixed specification: 27 functional requirements, endpoint
  catalog (EP-01..EP-20), screens (SCR-01..SCR-08), deterministic seed,
  fixed stack (PostgreSQL 16 / NestJS / React / Vitest / Playwright /
  Docker Compose).
- `acceptance/` — hidden batteries (gitignored; never part of what the
  generator sees).
- `runner/` — experiment runner: runs C1/C2/C3 in isolated workspaces
  and records metrics (see `runner/README.md`).

## Why the stack is fixed

If each run chose its own stack, observed differences between
configurations C1/C2/C3 would be attributable to the chosen technology,
not to the engineering layers under study. A single language across
layers also keeps SonarQube/Semgrep measurements comparable.

# Veritas: neatHack build log

## Project

Veritas is an autonomous dependency intelligence and remediation agent for JavaScript/TypeScript repositories. It finds dependency changes that matter, proves whether they affect a given repo, writes a fix in an isolated workspace, recovers from failed attempts, and verifies the result.

Tagline: Verified changes. Reliable software.

Full plan: [VERITAS_PLAN.md](VERITAS_PLAN.md)

## Team

Solo.

## Stack

- TypeScript on Node.js
- Models through the hackathon LiteLLM endpoint (OpenAI-compatible)
- neatlogs for tracing agent runs
- Entire for checkpoints and entire-graph
- cfo.ai for the business plan
- SQLite for agent state

## Build log

### 2026-10-10

Completed:
- Read the hackathon rules and the docs for neatlogs, Entire and cfo.ai. Wrote VERITAS_PLAN.md.
- Installed Entire CLI 0.11.4 from the official GitHub release (checksum verified) and the entire-graph plugin v0.4.0.
- Enabled Entire in the repo with commit linking set to always, and added the entire-graph agent instructions.
- Confirmed entire-graph supports JavaScript and TypeScript semantically (imports and calls) and needs no network. Output saved in `evidence/entire/graph-capabilities-js-ts.json`.

- Smoke test passed (run outside the repo): `neatlogs` 1.1.28 with `wrapOpenAI` on an `openai` 7.32.0 client pointed at the LiteLLM endpoint. The trace `veritas-smoke` showed a WORKFLOW span, a TOOL span and an LLM span for `claude-haiku` with token counts. Manual model-call tracing is not needed.

Findings to act on:
- The workflow span showed as "anonymous". Give every `span()` an explicit name.
- The trace showed tokens but no cost. Check whether neatlogs prices the LiteLLM model names; if not, compute cost from tokens ourselves.
- No Docker and no Homebrew on the dev machine; Node is v24. Use `VERITAS_SANDBOX=local` for development and confirm each benchmark case reproduces on the Node version in use.
- The first two commits have no Entire checkpoint because the hooks were installed mid-session. Checkpoints start with the next coding session.

- `entire login` done. Public repository created: https://github.com/Milliebanned/Veritas
- Entire checkpoints are being recorded from commit `688b89f` onward (the hooks loaded during the session, so a restart was not needed).
- Milestone 1: SQLite state store (`node:sqlite`, no native dependency), step journal with idempotency keys, orchestrator state machine with enforced transitions, neatlogs tracing wrapper with named spans, CLI (`investigate`, `resume`, `status`). All state handlers are stubs.
- Tests that ran: `npx vitest run` — 6 passed, 0 failed (journal reuse, failure retry, stub pipeline, crash and resume, illegal transition). `npx tsc --noEmit` clean.
- A stub investigation ran end to end through the CLI with tracing on.
- Milestone 0 verification finished for everything checkable from the dev machine: npm registry fields, `npm outdated` / `ls` / `audit` JSON, GitHub releases and advisories, OSV, `entire graph` on a CommonJS sample, `entire graph verify`, and checkpoint refs on the remote. Results in `evidence/m0-verification.md`; the plan's labels are updated.
- entire-graph `edges` output lists package usage directly (imports and call sites of an external package, with file and line). That is what the impact step will read.

Found in Milestone 0 verification:
- The first `GITHUB_TOKEN` in `.env` was rejected by GitHub (401 Bad credentials). It was replaced the same day; the new token is accepted with the `repo` scope and a 5,000 requests per hour limit.
- On Node 24, `require()` of an ESM-only package no longer throws; the call site fails instead (`chalk.red is not a function`). Benchmark cases 1 and 2 still reproduce, but each case must record its Node version and the sandbox must match it.
- `npm outdated --json` and `npm audit --json` exit 1 when they have findings. The npm tool must not treat that as a failure.
- `entire graph impact` prints text only. The agent parses `edges` and `neighbors` and keeps `impact` output as evidence.

- neatlogs shows token counts but no cost for the LiteLLM models. The LiteLLM endpoint returns the cost of each call in the `x-litellm-response-cost` header and the key's total spend in `x-litellm-key-spend`; the agent will record both.

- neatlogs trace links ask for a login when opened outside the account, so trace evidence is kept as screenshots in `evidence/neatlogs/`. The first two are saved: the smoke test trace and the Milestone 1 stub investigation trace.

Still to check by hand: whether Entire checkpoints open in a logged-out browser, and whether cfo.ai accepts typed assumptions.
- Milestone 2: eight benchmark cases in `bench/cases/`, each with ground truth (`case.yaml`), a held-out acceptance test and, for breaking cases, a reference fix. Five breaking changes (chalk, node-fetch, marked, uuid, express), one advisory case (lodash), two controls.
- Tests that ran: `node bench/reproduce.mjs` — 8 of 8 cases valid on Node v24.20.0. For the five breaking cases the project's tests pass on the old version, fail after the bump with a real error, and pass again with the reference fix. Results in `evidence/bench/reproduction.json` and `bench/README.md`. `npx vitest run` 6 passed; `npx tsc --noEmit` clean.
- Each breaking change was read from the package's own release notes; the URL and quote are in the case file.
- The first control case used uuid 3.4.0, which turned out to have a published advisory, so it was rebuilt on express 4.22.3 (no advisory) to keep it a clean control.
- Milestone 3: the first three agent states are real. INTAKE copies or clones the repository into a private workspace with a baseline commit. INVENTORY reads `package.json` and `package-lock.json` and runs `npm audit` against the lockfile. INTEL looks up each direct dependency in the npm registry, fetches release notes for every major version crossed (GitHub release, else the changelog section, plus a linked migration guide), fetches published advisories from the GitHub Advisory Database, and records candidate findings with their sources. No model is used yet.
- Tests that ran: `npx vitest run` — 34 passed, 0 failed (parsers against real recorded responses, retry and token fallback, the three states with recorded tools, a source that cannot be reached, resume without repeated lookups). `npx tsc --noEmit` clean.
- Ran for real on all 8 benchmark repositories: 10 candidate findings with 46 sources, every source read from its URL. The control with only an outdated package produced no finding. Summary in `evidence/m3/inventory-and-sources.json`.

Found in Milestone 3:
- The express 5.0.0 release notes do not list the removed methods; they link to a migration guide. INTEL now follows such links, so the removed APIs (`app.del`, `req.param`, `res.json(obj, status)`) are in the recorded source.
- A GitHub advisory can list several version ranges for one package, each with its own fix. The first version of the parser took the first range and reported the wrong fixed version for uuid 3.4.0 (12.0.1, correct is 11.1.1). It now uses the range that contains the installed version, with a test.
- uuid has no GitHub release for 7.0.0 and 8.0.0; those notes come from its `CHANGELOG.md`.
- One lodash advisory in the database was withdrawn in 2021 and is ignored.

Changed from the plan:
- State store uses Node's built-in `node:sqlite` instead of `better-sqlite3`. It avoids a native build on the dev machine and on EC2.
- The inventory is read from the lockfile directly; `npm outdated` and `npm ls` are not used, so nothing has to be installed to list dependencies.

## Demo

Not built yet.

## Known limitations and next steps

- INTAKE, INVENTORY and INTEL are real; the other states are still stubs. Findings are candidates (`potential`) until impact analysis exists.
- Only direct dependencies are checked for breaking changes; advisories cover the whole installed tree.
- Next: Milestone 4 (impact analysis with entire-graph, and prioritisation).

## Submission

Not submitted. Window opens 2026-10-12, 7:00 PM IST.

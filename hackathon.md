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

Still to check by hand: whether neatlogs shows cost for the LiteLLM models, whether trace links and Entire checkpoints open in a logged-out browser, and whether cfo.ai accepts typed assumptions.

Changed from the plan:
- State store uses Node's built-in `node:sqlite` instead of `better-sqlite3`. It avoids a native build on the dev machine and on EC2.

## Demo

Not built yet.

## Known limitations and next steps

- Every agent state is still a stub; no dependency analysis happens yet.
- Next: Milestone 2 (benchmark case repos with ground truth), then Milestone 3 (inventory and intelligence tools).

## Submission

Not submitted. Window opens 2026-10-12, 7:00 PM IST.

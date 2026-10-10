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

Pending:
- `entire login`.
- First Entire checkpoint.
- Public GitHub repository.

## Demo

Not built yet.

## Known limitations and next steps

- No application code yet.
- Next: Milestone 0 smoke tests, then the state store and agent skeleton (Milestone 1).

## Submission

Not submitted. Window opens 2026-10-12, 7:00 PM IST.

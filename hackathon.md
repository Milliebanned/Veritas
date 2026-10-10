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
- Milestone 4: IMPACT and PRIORITIZE are real, and the agent now uses the model. IMPACT builds a usage map from `entire graph edges` (import sites and calls into each package), with a source scan as fallback. For each breaking-change candidate the model works in a bounded tool loop (`read_file`, `search_code`, `find_callers` backed by `entire graph neighbors`, at most 12 calls) and must finish with a validated `report_impact` submission that names a verdict and a reason per site. Paths from the model are checked against the workspace. PRIORITIZE scores findings with the documented formula.
- Every model call is recorded with its tokens and the cost reported by LiteLLM, and counts against a per-investigation token limit.
- Tests that ran: `npx vitest run` — 51 passed, 0 failed (tool loop limits and error handling, graph parsing against real recorded output, fallback scan, path escape attempts, the priority formula, IMPACT with a scripted model). `npx tsc --noEmit` clean.
- Ran for real on all 8 benchmark repositories with `claude-haiku`: 8 of 8 verdicts correct, affected-file precision 11/11 and recall 11/11, both controls correct. Total cost $0.0893 for 57,585 tokens. Results in `evidence/m4/impact-accuracy.json`; a graph impact output from a run is in `evidence/entire/m4-veritas-run-graph-impact.txt`.
- On the express case the model named all four call sites with correct line numbers (`app.del`, `req.param`, and two `res.json(status, body)` calls). On the decoy in the marked case it correctly left `src/outline.js` out.
- Adopted a rule: anything neatlogs, Entire or cfo.ai can genuinely do is done with them, checked against their docs or CLI first.
- neatlogs, used more fully: one session per investigation; release and model-tier tags on every span; TOOL spans with `neatlogs.tool.name`; GUARDRAIL spans for the workspace path check and for validating the model's answer; logs for state changes, retries, step re-runs and failures; cost per model call; trace output. The agent's prompt is now a neatlogs managed prompt (`veritas-impact-analyst`, version 1, label `production`), loaded at run time, and each LLM span is linked to the prompt version. The coding agent reads traces through the neatlogs MCP server.
- Entire, used more fully: the agent's code search is now `entire graph search` instead of a hand-written text search. Saved `entire checkpoint list`, `entire tokens profile` and an `entire graph impact` answer from the build in `evidence/entire/`. `entire graph verify`, `explain` and `diff` are assigned to the repair states (Milestones 5 and 6).
- Tests that ran: `npx vitest run` — 51 passed. `npx tsc --noEmit` clean. One live investigation after the change: prompt loaded from neatlogs (version 1), verdict and affected files correct, 38 spans written, no API key present in the local span file.
- Second audit against the hackathon page's neatlogs and Entire sections. neatlogs: cost is now also recorded under neatlogs' own attribute names (`neatlogs.llm.cost_usd`, `.cost.prompt`, `.cost.completion`, `neatlogs.agent.cost_usd`, `neatlogs.agent.num_turns`); failures set `neatlogs.error.message`, `neatlogs.tool.is_error` and `neatlogs.agent.is_error`; every span carries the source file, line and function that opened it. Checked in the local span copy with three runs: a normal investigation, one that fails at intake (error status on the tool, step, state and root spans), and a request that fails twice with 503 before succeeding (three attempt spans, two marked as errors).
- Entire audit, honest result: `entire graph stats` reports 12 graph calls against 113 grep/read-style calls in the build sessions, a graph-first rate of 0%. The agent uses the graph at run time, but the build itself has mostly not. From here code is located with `entire graph search` / `impact` first.
- Entire features found but not usable yet: `entire search`, `recap` and the entire.io web view all need the repository mirrored to Entire, and mirroring fails with "account has no linked GitHub identity" because the Entire account was created with Google. Needs the owner to sign in to Entire with GitHub and install the Entire GitHub App.
- Planned Entire work: `entire graph verify`, `explain` and `diff` in the repair states; milestones developed on branches with pull requests; and, as a stretch, registering Veritas itself as an Entire agent through the Agent Integration Protocol so the fix commits it makes carry checkpoints with its reasoning.
- Milestone 5 (and the recovery loop planned for Milestone 6): the repair states are real. PLAN_REPAIR groups findings into one repair per package. BASELINE installs the current versions, runs the project's tests, upgrades the dependency on a branch and runs them again; a test that passed before and fails after is the proof, and only then is a breaking finding `confirmed`. PATCH is a model agent that can change code only through `apply_edit` (one exact, unique text replacement inside the workspace; lockfiles never, tests only with a stated reason). TEST reruns the tests. DIAGNOSE has a second model role read the real failure and the failed change and say what to do next; the failed attempt is reverted and PATCH tries again, up to 3 attempts, after which the finding is `unresolved`.
- Entire inside the repair loop: `entire graph verify` records a baseline and adjudicates each later run, `entire graph explain` resolves the symbols a failure names for the repair and diagnosis agents, `entire graph diff` lists the functions a patch touched. For projects that use Node's built-in test runner, `verify` can only give a pass/fail verdict; it reads test names for Jest and Vitest.
- Sandbox: repository commands run with a scrubbed environment (no API keys or tokens), a time limit that also stops child processes, and, in the container mode, no network for tests and only the workspace mounted. On this machine the mode is `local` (no Docker), which is safe only for the benchmark repositories written here. The container mode is written and unit-tested but has not run yet.
- Tests that ran: `npx vitest run` — 67 passed, 0 failed. `npx tsc --noEmit` clean. New tests cover the edit tool's refusals, the sandbox environment and time limit, the repair flow end to end with a scripted model (first-attempt fix, failed attempt then diagnosis then fix, attempt limit, a "not fixable" diagnosis, a blocked edit to a test), and the registry retry behaviour below.
- First full benchmark run with repairs, `claude-haiku`, local sandbox (`evidence/bench/dev-m5.json`): 7 of 8 verdicts correct; 5 of 6 fixable cases repaired and passing their held-out acceptance tests, all on the first attempt; both controls correct; 49 model calls, 302,053 tokens, $0.38, 350 seconds.
- The one failure was real and was not the model's. During the chalk case the npm registry timed out for about a minute. The quick retries ran out and the agent then reported no finding for chalk, as if the package were fine. That is a wrong answer delivered silently, which is the thing Veritas exists to prevent.
- Fix: registry and audit lookups now get two more rounds, 15 seconds apart, after the quick retries; and if the registry still does not answer, the package is recorded as `unchecked` and `unresolved` with the reason, never as clean. Two tests cover it. Rerunning the chalk case afterwards (`evidence/bench/dev-m5-chalk-rerun.json`): correct verdict, both files named, repaired on the first attempt, acceptance test passes.
- Not yet seen: a real failed attempt followed by a recovery. Every repair succeeded on its first attempt, including the express case with three removed APIs. The recovery path is covered by tests with a scripted model only. No failure has been staged.

Open problem (neatlogs platform, 2026-10-10):
- Traces sent after 12:53 UTC are accepted by neatlogs but never finish processing: the MCP server reports `status: processing`, `finalization_status: pending`, `span_count: 0` for all of them, including a two-span test trace. Only the first two traces of the day are readable.
- neatlogs' own SDK Doctor fails the same way: `neatlogs doctor --probe` passes every local check and then fails with `TRACE_READBACK_TIMEOUT`. Output saved in `evidence/neatlogs/doctor-probe-2026-10-10.json`. The SDK reports successful delivery with 0 dropped spans and 0 failed exports.
- Until it clears: every span is also written locally to `.veritas/spans/`, and Detections cannot be set up yet because neatlogs requires previewing them against finalized traces.
- `entire recap` and `entire activity` show no activity for the account although 17 checkpoints exist in the repository and on GitHub; `entire dispatch` and `entire review` need a coding-agent CLI on the PATH, which this machine's shell does not have.

Found in Milestone 3:
- The express 5.0.0 release notes do not list the removed methods; they link to a migration guide. INTEL now follows such links, so the removed APIs (`app.del`, `req.param`, `res.json(obj, status)`) are in the recorded source.
- A GitHub advisory can list several version ranges for one package, each with its own fix. The first version of the parser took the first range and reported the wrong fixed version for uuid 3.4.0 (12.0.1, correct is 11.1.1). It now uses the range that contains the installed version, with a test.
- uuid has no GitHub release for 7.0.0 and 8.0.0; those notes come from its `CHANGELOG.md`.
- One lodash advisory in the database was withdrawn in 2021 and is ignored.

Changed from the plan:
- State store uses Node's built-in `node:sqlite` instead of `better-sqlite3`. It avoids a native build on the dev machine and on EC2.
- The fallback impact provider is a source text scan, not the TypeScript compiler API.
- The inventory is read from the lockfile directly; `npm outdated` and `npm ls` are not used, so nothing has to be installed to list dependencies.

## Demo

Not built yet.

## Known limitations and next steps

- Every state except REPORT is real. Verification so far is "the project's tests pass"; the stricter rules (no regressions per test, diff limited to planned files) and the report are next.
- The benchmark has not produced a failed-then-recovered repair yet, and scored runs have not happened on the server.
- Impact accuracy is perfect on this benchmark, so it shows no room to improve yet. The repair stages are where failures are expected.
- Only direct dependencies are checked for breaking changes; advisories cover the whole installed tree.
- Next: verification rules and the report (rest of Milestone 6), then the server and the baseline benchmark (Milestone 7).

## Submission

Not submitted. Window opens 2026-10-12, 7:00 PM IST.

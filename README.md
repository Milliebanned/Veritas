# Veritas

**Verified changes. Reliable software.**

Veritas is an agent for JavaScript and TypeScript projects that use npm. Point it at a repository and it finds the dependency upgrades and published advisories that matter, proves whether each one breaks that repository, writes a fix on a branch, and checks the fix against the project's own tests. It reports what it proved, what it could not prove, and what it could not check.

Dependency tools tell you that something changed. Veritas answers the next four questions with evidence:

1. What changed in the dependency?
2. Does it affect this repository?
3. What is the smallest reasonable fix?
4. Does the fix work?

Built for [neatHack](https://neatlogs.com/hackathon), October 10–12, 2026. This is a work in progress; the [Status](#status) section says what exists today.

## How it works

Veritas is a state machine. Plain code drives the states and enforces the limits; a model makes the decisions inside three of them.

| State | What happens | Model |
|---|---|---|
| Intake | Copies or clones the repository into a private workspace. The original is never touched. | |
| Inventory | Reads `package.json` and `package-lock.json`; runs `npm audit` against the lockfile. Nothing from the repository is installed or executed. | |
| Intel | For each direct dependency: latest version from the npm registry, release notes for every major version crossed (GitHub release, changelog, linked migration guide), and advisories from the GitHub Advisory Database. Every source is stored with its URL. | |
| Impact | Finds where each package is used with the code graph, then reads those files and gives a verdict and a reason per call site. | yes |
| Prioritize | Scores findings: `0.35·severity + 0.30·usage + 0.20·confidence + 0.15·fixAvailable`. | |
| Baseline | Runs the project's tests, upgrades the dependency on a branch, runs them again. A test that passed before and fails after is the proof; only then is a finding `confirmed`. | |
| Patch | Changes code through one tool: replace an exact piece of text in one file inside the workspace. Lockfiles never; tests only with a stated reason. | yes |
| Test | Reruns the project's tests. | |
| Diagnose | On failure, reads the real output and the failed change and says what to try next. The attempt is reverted. Three attempts, then the finding is `unresolved`. | yes |

Three rules hold throughout:

- **The model proposes; tests decide.** A fix counts only when tests that failed after the upgrade pass again.
- **Nothing is reported as fine by default.** A package that could not be checked is recorded as `unchecked`, not as clean.
- **Every step is journaled.** An interrupted investigation resumes without repeating finished steps.

## How the hackathon tools are used

### neatlogs

- Every run is traced: model calls and tool calls with inputs and outputs, one span per state, retries, failures, tokens, latency and cost.
- One session per investigation, so a resumed run joins the original.
- Guardrail spans mark blocked actions: a path outside the workspace, an edit to a test, a model answer that failed validation.
- The agent's prompts are neatlogs managed prompts, versioned, loaded at run time.
- Detections flag bad runs. The first improvement to the agent came this way: neatlogs flagged a run where 12 of 14 edits were refused, neat AI investigated it and opened [pull request #2](https://github.com/Milliebanned/Veritas/pull/2). On that case, refused edits went from 12 to 0 and cost from $0.14 to $0.05. Details in [hackathon.md](hackathon.md).

### Entire

- Checkpoints: commits carry an `Entire-Checkpoint` trailer linking the change to the session that produced it. Browse them at [entire.io/gh/Milliebanned/Veritas](https://entire.io/gh/Milliebanned/Veritas).
- entire-graph at run time: `edges` for where a package is used, `neighbors` for callers, `search` for code search, `verify` to judge a test run against a recorded baseline, `explain` to resolve the symbols a failure names, `diff` to list the functions a patch touched.

### cfo.ai

The business plan (pricing, costs, revenue, runway) is built in cfo.ai from the measured cost per investigation. Not written yet.

## Results so far

Nine small benchmark repositories with known answers, each checked against the real packages from npm: six breaking upgrades (chalk, node-fetch twice, marked, uuid, express), one advisory case (lodash), two controls. Each has a held-out acceptance test the agent never sees. See [bench/README.md](bench/README.md).

Full run on October 11 on an EC2 `t3.large`, `claude-haiku`, project commands in Docker with no network for tests ([evidence/bench/server-v1-haiku.json](evidence/bench/server-v1-haiku.json)):

| | |
|---|---|
| Verdicts correct | 9 of 9 |
| Fixable cases repaired, acceptance test passing | 7 of 7, all on the first attempt |
| Controls correct | 2 of 2 |
| Affected files: recall / precision | 13 of 13 / 13 of 17 |
| Duration, cost | 236 s, $0.80 |

The first full run, a day earlier, had 7 of 8 verdicts and 5 of 6 repairs, and the hardest case was unresolved on its first run. Two problems found through neatlogs were fixed in between; their before and after figures are in [hackathon.md](hackathon.md). Precision on affected files is the weak number: impact analysis flags some test files that do not need to change.

## Run it

Requirements: Node.js 22.13 or later, git, the [Entire CLI](https://docs.entire.io/installation) with the graph plugin (`entire plugin install graph`), and Docker unless you set `VERITAS_SANDBOX=local`.

```bash
npm install
cp .env.example .env    # then fill in the keys
```

| Variable | Purpose |
|---|---|
| `LITELLM_API_KEY`, `LITELLM_BASE_URL` | OpenAI-compatible model endpoint |
| `VERITAS_MODEL`, `VERITAS_MODEL_FAST` | Model ids; `VERITAS_TIER=main` selects the first, otherwise the second is used |
| `NEATLOGS_API_KEY` | Tracing. Without it the agent runs untraced with its checked-in prompts. |
| `GITHUB_TOKEN` | Higher GitHub API limits |
| `VERITAS_SANDBOX` | `docker` (default) or `local` |

```bash
npx tsx src/cli.ts investigate <path-or-github-url>   # start an investigation
npx tsx src/cli.ts resume <investigation-id>          # continue an interrupted one
npx tsx src/cli.ts status [investigation-id]          # list investigations, or the steps of one
npx tsx src/cli.ts report <investigation-id>          # the investigation's report
npx tsx src/cli.ts export <investigation-id>          # findings, sources, repairs and test runs as JSON
npm run serve                                         # the web interface on http://localhost:3210
```

```bash
npm test                          # unit and integration tests (no network, no model)
npm run typecheck
node bench/reproduce.mjs          # confirm every benchmark case against the real packages
npx tsx bench/run.mts <tag>       # run the agent on the benchmark; writes evidence/bench/<tag>.json
```

## Safety

- Repository commands run with a scrubbed environment: no API keys or tokens reach repository code.
- Installs use `--ignore-scripts`. Commands have a time limit that also stops their child processes.
- In the container sandbox, tests run with no network and only the workspace mounted.
- `VERITAS_SANDBOX=local` runs repository code directly on your machine. Use it only for repositories you wrote.
- Paths from the model are checked against the workspace. Lockfiles and installed packages cannot be edited.
- The original repository is not modified. Fixes live on a `veritas/<package>` branch in the workspace.

## Status

Working today:

- All states above, from the command line and from a web interface (`npm run serve`, then open http://localhost:3210).
- The report, and an approval step: nothing leaves the workspace until a person approves.
- 79 automated tests.
- The benchmark runner with held-out acceptance scoring.

Not built yet:

- Opening a pull request on approval is written but has not been run against GitHub.
- A real failed-then-recovered repair. On the hardest benchmark case the agent tried three times and reported the finding unresolved; see [the report](evidence/reports/09-node-fetch-timeout-unresolved.md).

Limits by design: npm only, no monorepos, direct dependencies only for breaking changes, public repositories only.

## Repository layout

```
src/agent/          states: intake, intel, impact, prioritize, repair; orchestrator
src/tools/          registry, release notes, advisories, code graph, sandbox, test runner, edit tool
src/llm/            model client, bounded tool loop, prompts
src/state/          SQLite schema, journal, records
src/observability/  neatlogs tracing
bench/              benchmark cases, reproduction check, runner
tests/              test suite and recorded fixtures
evidence/           benchmark results, traces, Entire and neatlogs evidence
VERITAS_PLAN.md     the plan
hackathon.md        dated build log
```

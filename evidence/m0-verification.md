# Milestone 0: verification of the plan's [To verify] items

Run on 2026-10-10 from the dev machine (macOS arm64, Node v24.20.0, npm 11.19.0, Entire CLI 0.11.4, entire-graph v0.4.0). Every result below was observed from a real command or HTTP response.

## Summary

| Item (plan section) | Result | What it means for the build |
|---|---|---|
| `wrapOpenAI` traces through LiteLLM (16) | Confirmed earlier | No manual model-call tracing |
| entire-graph JS/TS support, no network (14) | Confirmed | `GraphProvider` is primary |
| `entire graph` finds package usage (14) | Confirmed | `edges` gives external import and call sites; see below |
| `entire graph verify` usage (15) | Confirmed, with limits | Optional cross-check only |
| Node and `require()` of ESM-only packages (8) | Confirmed; behaviour differs from the plan's assumption | Cases 1 and 2 still break, with a different error |
| npm registry fields (13) | Confirmed | |
| `npm outdated` / `ls` / `audit` JSON (13) | Confirmed | Exit code 1 is not an error |
| GitHub releases (13) | Confirmed | |
| GitHub global advisories (13) | Confirmed | |
| OSV (13) | Confirmed | |
| Checkpoints reach the remote (17) | Confirmed | Pushed as `refs/entire/checkpoints/*` |
| Entire CLI on Linux (14) | Release asset exists; install not yet run | Run on EC2 in M10 |
| `GITHUB_TOKEN` in `.env` | First token failed with 401; replaced and confirmed (scope `repo`, 5,000 requests per hour) | Ready for M3 and for opening pull requests |
| neatlogs shows cost for LiteLLM models (16) | **No**: the `veritas-smoke` trace shows tokens only | Take cost from LiteLLM's `x-litellm-response-cost` response header |
| Trace links viewable outside the account (16) | **No**: a trace link opened in a private window asks for a login | Evidence is screenshots in `evidence/neatlogs/`, which the rules accept |
| Checkpoints viewable by judges on entire.io (17) | Not verified | Needs a logged-out browser |
| cfo.ai accepts typed assumptions (18) | Not verified | Owner action |

## Details

### Node and ESM-only packages

The plan pinned Node 20 because newer Node can `require()` ES modules. On Node v24.20.0, in a CommonJS file with chalk 5 and node-fetch 3 installed:

- `require('chalk')` succeeds and returns a namespace object. `chalk.red('x')` then throws `TypeError: m.red is not a function`.
- `require('node-fetch')` succeeds and returns a namespace object, not a function. Calling it throws `TypeError`.
- With `node --no-experimental-require-module`, both fail at `require()` with `ERR_REQUIRE_ESM`, which is the Node 20 behaviour.

So the breakage is real on both Node lines, but the error and the correct fix differ. On Node 22+ `require('chalk').default` is a valid one-line fix; on Node 20 it is not. Each benchmark case must record the Node version it was reproduced on, and the sandbox must run that same version.

### entire-graph on a CommonJS sample

A five-file sample repo (`src/log.js` requires chalk; `src/report.js` calls into it; one test).

- `entire graph search --repo . --profile full --query "..."` returns JSON on stdout with ranked results (`file_path`, `start_line`, `symbol_name`, `snippet`).
- `entire graph edges --repo .` returns NDJSON. Package usage appears directly:
  - `IMPORTS` from `local/<repo>:file:src/log.js` to `external:import:chalk`
  - `CALLS` from the function `formatError` to `external:symbol:chalk.red`, with file and line in `evidence`
- `entire graph neighbors --symbol X --relation CALLS --direction in` returns JSON with `call_site.file_path` and `call_site.line`.
- `entire graph impact --symbol X` returns **text only**; it rejects `--json`. It reported direct and transitive callers, including the test file.
- Works on a repo with a single commit, no login, no network (`entire graph doctor` reports `no_egress=true`).

Consequence: the usage map should be built from `edges` (filter `to_id` on `external:import:<pkg>` and `external:symbol:<pkg>.*`) and `neighbors`, both machine-readable. `impact` output is stored as human-readable evidence, not parsed.

Saved outputs: `entire/m0-sample-graph-edges.ndjson`, `entire/m0-sample-graph-impact.txt`.

### `entire graph verify`

`--record-baseline <file>` on the clean tree, then `--pre-edit-baseline <file>` after the edit. It recognises jest and vitest output and reports which tests newly pass or fail. With `node --test` the output is not recognised and the verdict is exit-code only. The command itself exits 0 even when the verdict is FAIL, so the verdict line must be read. Veritas keeps its own test runner as the source of truth.

### npm registry

- `GET https://registry.npmjs.org/<pkg>` (full document): top-level `dist-tags`, `versions`, `time` (version to publish date), `repository.url`. Each version object carries `deprecated` (a string) when deprecated; checked on `request@2.88.2`.
- With `Accept: application/vnd.npm.install-v1+json` the document is much smaller but each version keeps only `name`, `version`, `dist`, `engines`, dependency fields. Use the full document when `time` or `repository` is needed.
- `GET /<pkg>/<version-or-tag>` returns one version, including `type` and `exports` (chalk latest: `"type": "module"`).

### npm CLI

In a project with chalk 4.1.2, node-fetch 2.6.7, lodash 4.17.15, uuid 8.3.2, marked 3.0.8:

- `npm outdated --json`: object keyed by package with `current`, `wanted`, `latest`, `dependent`, `location`. **Exits 1 when anything is outdated.**
- `npm ls --all --json`: `{ version, name, dependencies }`, nested; each node has `version`, `resolved`, `overridden`, `dependencies`. Deduplicated nodes appear as `{}`.
- `npm audit --json`: `{ auditReportVersion, vulnerabilities, metadata }`. Each vulnerability has `name`, `severity`, `isDirect`, `range`, `fixAvailable` and `via[]`; a `via` entry is either an advisory object (`title`, `url` to a GHSA page, `severity`, `cwe`, `cvss`, `range`) or a package-name string for transitive paths. **Exits 1 when vulnerabilities exist.**

### GitHub REST

Both work without a token (60 requests per hour unauthenticated).

- `GET /repos/{owner}/{repo}/releases?per_page=100`: array with `tag_name`, `name`, `published_at`, `prerelease`, `body`, `html_url`. chalk `v5.0.0` body begins "### Breaking ... This package is now pure ESM".
- `GET /advisories?ecosystem=npm&affects=lodash@4.17.15`: 7 advisories, each with `ghsa_id`, `cve_id`, `severity`, `type` (`reviewed` or `unreviewed`), `html_url`, and `vulnerabilities[]` holding `package.name`, `vulnerable_version_range`, `first_patched_version`. Severity uses `medium` where npm audit and OSV use `moderate`; one result was `unreviewed` and should not be treated as confirmed.

### OSV

`POST https://api.osv.dev/v1/query` with `{"package":{"name":"lodash","ecosystem":"npm"},"version":"4.17.15"}` returned 6 vulnerabilities with GHSA ids, `database_specific.severity`, and `affected[].ranges[].events` (`introduced` / `fixed`). No key needed.

### Cost per model call

The neatlogs trace for `claude-haiku` shows token counts (14 prompt, 4 completion) and no cost. The LiteLLM endpoint reports cost itself: every chat completion response carries `x-litellm-response-cost` (USD for that call, also split into `-input` and `-output`) and `x-litellm-key-spend` (total spent on the key so far). One 13-token `claude-haiku` call returned a cost of 3.63e-05 USD.

Consequence: the LLM client reads these headers on every call, stores cost in the journal, and sets it as a span attribute so it also appears in neatlogs. `x-litellm-key-spend` gives a running check against the $20 budget.

### Entire checkpoints

`git ls-remote origin` shows `refs/entire/checkpoints/...` next to `refs/heads/main`: the pre-push hook pushes checkpoint refs to GitHub. `entire checkpoint list` shows one checkpoint per commit from `688b89f` onward.

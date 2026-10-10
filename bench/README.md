# Benchmark

Eight small CommonJS projects with known answers. Veritas is scored on them before and after each improvement. They were written during the hackathon and every one is checked against the real packages from npm; nothing is simulated.

## Layout of a case

```
bench/cases/<id>/
  case.yaml     ground truth: the upgrade, the expected verdict, the affected files, known advisories, sources
  repo/         the project Veritas is given (package.json, package-lock.json, src/, test/)
  acceptance/   held-out test; Veritas never sees it
  solution/     one known-good fix, used only to prove the case can be solved (breaking cases)
```

Only `repo/` is copied into the agent's workspace. After a run, the scorer copies `acceptance/` into the patched workspace and runs `node --test "acceptance/**/*.test.js"`. The acceptance tests check behaviour and that the dependency really moved off the old version; they accept any fix that does both, including replacing the dependency.

`expected.verdict` is one of:
- `affected`: the upgrade or advisory matters for this project and a fix exists.
- `not_affected`: the package has a breaking change, but this project does not use what changed.
- `no_finding`: the package is behind, with no breaking change and no advisory.

`expected.affected_files` lists the files that must change for a breaking case, and the files that use the package for an advisory case.

## Reproduced cases

Confirmed with `node bench/reproduce.mjs` on Node v24.20.0 (macOS arm64) on 2026-10-10. Full output: `evidence/bench/reproduction.json`.

| # | Case | Upgrade | Tests before | Tests after the bump | Failure after the bump | Reference fix |
|---|---|---|---|---|---|---|
| 1 | chalk became ESM-only | chalk 4.1.2 → 6.0.1 | pass | **fail** | `TypeError: chalk.cyan is not a function` | tests and acceptance pass |
| 2 | node-fetch became ESM-only | node-fetch 2.7.0 → 3.3.2 | pass | **fail** | `TypeError: fetch is not a function` | tests and acceptance pass |
| 3 | marked removed its default export | marked 3.0.8 → 18.1.0 | pass | **fail** | `TypeError: marked is not a function` | tests and acceptance pass |
| 4 | uuid removed deep imports | uuid 3.4.0 → 14.0.3 | pass | **fail** | `ERR_PACKAGE_PATH_NOT_EXPORTED` for `./v4` | tests and acceptance pass |
| 5 | express removed `app.del`, `req.param`, `res.json(status, body)` | express 4.22.3 → 5.3.0 | pass | **fail** | `TypeError: app.del is not a function` | tests and acceptance pass |
| 6 | lodash has six published advisories | lodash 4.17.15 → 4.18.1 | pass | pass | none; the acceptance test fails before the bump and passes after | not needed (version bump) |
| 7 | Control: express 5 removals, none used | express 4.22.3 → 5.3.0 | pass | pass | none | not needed |
| 8 | Control: outdated only | semver 7.5.4 → 7.8.5 | pass | pass | none | not needed |

Notes:
- **Case 6 is a real exposure.** On lodash 4.17.15, the project's `fromFlat({ '__proto__.x': true })` pollutes `Object.prototype` (GHSA-p6mc-m468-83gw). The acceptance test checks that it no longer does.
- **Cases 3 and 4 also start on versions with published advisories** (marked: 2, uuid: 1). They are listed under `advisories` in `case.yaml`, so reporting them counts as correct.
- **Case 3 has a decoy.** `src/outline.js` requires marked but only calls `marked.lexer`, which still works. Only `src/render.js` must change.
- **Case 5 has three separate removals in two files**, and they do not all fail at once: fixing `app.del` exposes the next failure.
- **Cases 7 and 8 measure false positives.** Case 7's starting version has no advisory and its tests pass unchanged on express 5.

## Node version

The failures above are for Node 22 or later, where `require()` can load ES modules. An ESM-only package then loads, and the call site fails. On Node 20 the same upgrades fail earlier with `ERR_REQUIRE_ESM`, and the reference fixes for cases 1 and 2 (`require('chalk').default`) do not apply. Scored runs must use Node 22+.

// Confirms every benchmark case against the real packages, with no model involved.
// For each case: install the old version, run the tests, bump the dependency, run them again,
// then apply the reference solution and run the held-out acceptance test.
//
// Usage: node bench/reproduce.mjs [case-id ...]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const benchDir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(benchDir, 'cases');
const workRoot = join(realpathSync(tmpdir()), 'veritas-bench-reproduce');
const NPM_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];
const ACCEPTANCE = ['--test', 'acceptance/**/*.test.js'];

function run(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function firstError(output) {
  const line = output.split('\n').find((l) => /\b[A-Za-z]*Error\b.*:/.test(l) || /ERR_[A-Z_]+/.test(l));
  return line ? line.trim().replace(/^error: /, '').replaceAll(workRoot, '').slice(0, 160) : null;
}

const word = (ok) => (ok ? 'pass' : 'fail');

function reproduce(id) {
  const caseDir = join(casesDir, id);
  const spec = parse(readFileSync(join(caseDir, 'case.yaml'), 'utf8'));
  const work = join(workRoot, id);
  rmSync(work, { recursive: true, force: true });
  cpSync(join(caseDir, 'repo'), work, { recursive: true });

  const install = run(work, 'npm', ['ci', ...NPM_FLAGS]);
  if (!install.ok) throw new Error(`${id}: npm ci failed\n${install.output}`);
  cpSync(join(caseDir, 'acceptance'), join(work, 'acceptance'), { recursive: true });

  const baseline = run(work, 'npm', ['test']);
  const acceptanceAtBaseline = run(work, 'node', ACCEPTANCE);

  const bump = run(work, 'npm', ['install', ...NPM_FLAGS, `${spec.package}@${spec.to}`]);
  if (!bump.ok) throw new Error(`${id}: bump failed\n${bump.output}`);
  const afterBump = run(work, 'npm', ['test']);
  const acceptanceAfterBump = run(work, 'node', ACCEPTANCE);

  const hasSolution = existsSync(join(caseDir, 'solution'));
  let afterSolution = null;
  let acceptanceAfterSolution = null;
  if (hasSolution) {
    cpSync(join(caseDir, 'solution'), work, { recursive: true });
    afterSolution = run(work, 'npm', ['test']);
    acceptanceAfterSolution = run(work, 'node', ACCEPTANCE);
  }

  const observed = {
    baseline_tests: word(baseline.ok),
    acceptance_at_baseline: word(acceptanceAtBaseline.ok),
    tests_after_bump: word(afterBump.ok),
    error_after_bump: afterBump.ok ? null : firstError(afterBump.output),
    acceptance_after_bump: word(acceptanceAfterBump.ok),
    tests_after_solution: afterSolution && word(afterSolution.ok),
    acceptance_after_solution: acceptanceAfterSolution && word(acceptanceAfterSolution.ok),
  };

  // What a valid case of each type must show.
  const want = {
    breaking: {
      baseline_tests: 'pass',
      acceptance_at_baseline: 'fail',
      tests_after_bump: 'fail',
      acceptance_after_bump: 'fail',
      tests_after_solution: 'pass',
      acceptance_after_solution: 'pass',
    },
    advisory: {
      baseline_tests: 'pass',
      acceptance_at_baseline: 'fail',
      tests_after_bump: 'pass',
      acceptance_after_bump: 'pass',
    },
    control: {
      baseline_tests: 'pass',
      acceptance_at_baseline: 'pass',
      tests_after_bump: 'pass',
      acceptance_after_bump: 'pass',
    },
  }[spec.type];
  const mismatches = Object.entries(want)
    .filter(([key, value]) => observed[key] !== value)
    .map(([key, value]) => `${key}: wanted ${value}, got ${observed[key]}`);

  return { id, type: spec.type, package: spec.package, from: spec.from, to: spec.to, ...observed, valid: mismatches.length === 0, mismatches };
}

const ids = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(casesDir).filter((d) => existsSync(join(casesDir, d, 'case.yaml'))).sort();
mkdirSync(workRoot, { recursive: true });
const results = ids.map((id) => {
  const result = reproduce(id);
  console.log(`${result.valid ? 'ok  ' : 'BAD '} ${id}${result.valid ? '' : `  ${result.mismatches.join('; ')}`}`);
  return result;
});

const report = { node: process.version, platform: `${process.platform}-${process.arch}`, ran_at: new Date().toISOString(), results };
if (process.argv.length === 2) {
  const out = join(benchDir, '..', 'evidence', 'bench', 'reproduction.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = results.every((r) => r.valid) ? 0 : 1;

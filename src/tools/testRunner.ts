import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Sandbox } from './sandbox.ts';

export interface TestRun {
  command: string;
  exitCode: number | null;
  ok: boolean;
  timedOut: boolean;
  /** Counts read from the runner's summary, when its format is recognised. */
  passed: number | null;
  failed: number | null;
  durationMs: number;
  logPath: string;
  /** The end of the output, where runners print failures and the summary. */
  tail: string;
}

const TAIL_CHARS = 6000;
const last = (matches: RegExpMatchArray[], group = 1) => (matches.length ? Number(matches.at(-1)![group]) : null);

/** Pass and fail counts from the summary lines of node:test, Jest, Vitest and Mocha. */
export function parseCounts(output: string): { passed: number | null; failed: number | null } {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '');
  // node:test prints `# pass 3` with the TAP reporter and `ℹ pass 3` with the default one.
  const tap = { passed: last([...text.matchAll(/^(?:#|ℹ) pass (\d+)$/gm)]), failed: last([...text.matchAll(/^(?:#|ℹ) fail (\d+)$/gm)]) };
  if (tap.passed !== null || tap.failed !== null) return { passed: tap.passed ?? 0, failed: tap.failed ?? 0 };

  const jest = [...text.matchAll(/^\s*Tests:\s+(.*)$/gm)].at(-1)?.[1];
  if (jest) {
    return { passed: Number(/(\d+) passed/.exec(jest)?.[1] ?? 0), failed: Number(/(\d+) failed/.exec(jest)?.[1] ?? 0) };
  }
  const mocha = { passed: last([...text.matchAll(/^\s*(\d+) passing\b/gm)]), failed: last([...text.matchAll(/^\s*(\d+) failing\b/gm)]) };
  if (mocha.passed !== null || mocha.failed !== null) return { passed: mocha.passed ?? 0, failed: mocha.failed ?? 0 };
  return { passed: null, failed: null };
}

/** Splits `npm test` style command strings; quoting is left to the shell inside the sandbox. */
function shell(command: string): { command: string; args: string[] } {
  return { command: 'sh', args: ['-c', command] };
}

export async function runInstall(sandbox: Sandbox, cwd: string, args: string[], timeoutMs: number, logPath: string) {
  const result = await sandbox({ cwd, command: 'npm', args: [...args, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], timeoutMs, network: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, result.output);
  return { ok: result.exitCode === 0, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, logPath, tail: result.output.slice(-TAIL_CHARS) };
}

/** Runs the project's own test command with the network off and keeps the full log on disk. */
export async function runTests(sandbox: Sandbox, cwd: string, command: string, timeoutMs: number, logPath: string): Promise<TestRun> {
  const result = await sandbox({ cwd, ...shell(command), timeoutMs, network: false });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, result.output);
  return {
    command,
    exitCode: result.exitCode,
    ok: result.exitCode === 0 && !result.timedOut,
    timedOut: result.timedOut,
    ...parseCounts(result.output),
    durationMs: result.durationMs,
    logPath,
    tail: result.output.slice(-TAIL_CHARS),
  };
}

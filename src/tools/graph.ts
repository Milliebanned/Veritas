import { execFile } from 'node:child_process';

export interface UsageSite {
  file: string;
  line: number | null;
  /** Enclosing function or class, when the provider knows it. */
  symbol: string | null;
  /** What is used: the imported specifier (`uuid/v4`) or the member called (`marked.lexer`). */
  uses: string;
  kind: 'import' | 'call';
  provider: 'graph' | 'fallback';
}

export interface Caller {
  symbol: string;
  file: string;
  line: number | null;
}

export interface CodeHit {
  file: string;
  line: number;
  symbol: string | null;
  snippet: string;
}

interface Relation {
  record_type?: string;
  type?: string;
  from_id?: string;
  to_id?: string;
  evidence?: { file_path?: string; start_line?: number; detail?: string }[];
}

const IMPORT = 'external:import:';
const SYMBOL = 'external:symbol:';

/** True when an import specifier refers to the package itself or a path inside it (`uuid`, `uuid/v4`). */
export const belongsTo = (specifier: string, pkg: string) => specifier === pkg || specifier.startsWith(`${pkg}/`);

/** `local/repo:JavaScript:src/a.js:function:name` → `name`; file-level ids have no symbol. */
function symbolOf(fromId: string): string | null {
  const parts = fromId.split(':');
  return parts.length >= 5 ? (parts.at(-1) ?? null) : null;
}

/**
 * Reads `entire graph edges` output and keeps the places that import `pkg` or call into it.
 * The graph reports these as relations to `external:import:<specifier>` and
 * `external:symbol:<specifier>.<member>`.
 */
export function parseEdges(ndjson: string, pkg: string): UsageSite[] {
  const sites: UsageSite[] = [];
  for (const line of ndjson.split('\n')) {
    if (!line.includes('"relation"') || !line.includes('external:')) continue;
    let rel: Relation;
    try {
      rel = JSON.parse(line) as Relation;
    } catch {
      continue;
    }
    const to = rel.to_id ?? '';
    const evidence = rel.evidence?.[0];
    if (!evidence?.file_path) continue;
    const base = { file: evidence.file_path, line: evidence.start_line ?? null, symbol: symbolOf(rel.from_id ?? ''), provider: 'graph' as const };

    if (rel.type === 'IMPORTS' && to.startsWith(IMPORT) && belongsTo(to.slice(IMPORT.length), pkg)) {
      sites.push({ ...base, uses: to.slice(IMPORT.length), kind: 'import' });
    } else if (rel.type === 'CALLS' && to.startsWith(SYMBOL)) {
      const target = to.slice(SYMBOL.length);
      if (target.startsWith(`${pkg}.`) || target.startsWith(`${pkg}/`)) sites.push({ ...base, uses: evidence.detail ?? target, kind: 'call' });
    }
  }
  return sites;
}

function entireGraph(repoDir: string, args: string[], timeoutMs: number, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('entire', ['graph', ...args], { cwd: repoDir, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(new Error(`entire graph ${args[0]} failed: ${err.message.split('\n')[0]}`)) : resolve(stdout),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** Every relation in the repository's code graph, as NDJSON. Runs locally; the graph makes no network calls. */
export const graphEdges = (repoDir: string, timeoutMs = 120_000) => entireGraph(repoDir, ['edges', '--repo', '.'], timeoutMs);

/** Functions that call `symbol`, from the code graph. */
export async function graphCallers(repoDir: string, symbol: string, timeoutMs = 60_000): Promise<Caller[]> {
  const out = await entireGraph(repoDir, ['neighbors', '--repo', '.', '--symbol', symbol, '--relation', 'CALLS', '--direction', 'in'], timeoutMs);
  const parsed = JSON.parse(out) as { matches?: { incoming?: { endpoint?: { name?: string; file_path?: string }; call_site?: { file_path?: string; line?: number } }[] }[] };
  return (parsed.matches ?? []).flatMap((m) =>
    (m.incoming ?? []).map((edge) => ({
      symbol: edge.endpoint?.name ?? '(file)',
      file: edge.call_site?.file_path ?? edge.endpoint?.file_path ?? '',
      line: edge.call_site?.line ?? null,
    })),
  );
}

/** The graph's own blast-radius report for a symbol. Human-readable text, kept as evidence. */
export const graphImpactText = (repoDir: string, symbol: string, timeoutMs = 60_000) =>
  entireGraph(repoDir, ['impact', '--repo', '.', '--symbol', symbol], timeoutMs);

/** Ranked code search from the graph: plain-language or symbol queries, answered locally. */
export async function graphSearch(repoDir: string, query: string, timeoutMs = 60_000): Promise<CodeHit[]> {
  const out = await entireGraph(repoDir, ['search', '--repo', '.', '--profile', 'full', '--query', query], timeoutMs);
  const parsed = JSON.parse(out) as { results?: { file_path?: string; start_line?: number; symbol_name?: string; snippet?: string; language?: string }[] };
  return (parsed.results ?? [])
    .filter((r) => r.file_path && r.language !== 'JSON')
    .slice(0, 12)
    .map((r) => ({ file: r.file_path!, line: r.start_line ?? 1, symbol: r.symbol_name ?? null, snippet: (r.snippet ?? '').trim().slice(0, 300) }));
}

export interface Verdict {
  /** The verdict line, for example `VERDICT: FAIL (exit 1)`. */
  verdict: string;
  passed: boolean;
  /** `exit-code-only` when the runner's output format is not one the graph can read test names from. */
  detail: string;
}

/**
 * Records the test result of the unmodified tree, so a later run can be judged against it.
 * `entire graph verify` runs the command itself; it is given a scrubbed environment.
 */
export async function graphRecordBaseline(repoDir: string, testCommand: string, baselinePath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return runVerify(repoDir, ['--test', testCommand, '--record-baseline', baselinePath], env, timeoutMs);
}

/** Runs the tests again and has the graph adjudicate them against the recorded baseline: which tests newly fail, newly pass, or were already failing. */
export async function graphVerify(repoDir: string, testCommand: string, baselinePath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Verdict> {
  const out = await runVerify(repoDir, ['--test', testCommand, '--pre-edit-baseline', baselinePath], env, timeoutMs);
  const verdict = out.split('\n').find((line) => line.startsWith('VERDICT:')) ?? out.split('\n')[0] ?? '';
  // The verdict is a delta against the baseline: FAIL means something that passed now fails. PASS and NO EFFECT both mean nothing regressed.
  return { verdict, passed: !/^VERDICT:\s*FAIL/.test(verdict), detail: out.trim().slice(0, 2000) };
}

function runVerify(repoDir: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('entire', ['graph', 'verify', '--repo', '.', ...args], { cwd: repoDir, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err && !stdout ? reject(new Error(`entire graph verify failed: ${(stderr || err.message).split('\n')[0]}`)) : resolve(stdout),
    );
  });
}

/** Declarations of the symbols a failing build or test names, resolved from the working tree. */
export const graphExplain = (repoDir: string, failureOutput: string, timeoutMs = 60_000) =>
  entireGraph(repoDir, ['explain', '--repo', '.', '--no-echo', '--format', 'agent'], timeoutMs, failureOutput);

export interface EntityChange {
  file: string;
  type: string;
  kind: string;
  name: string;
  dependents: number;
}

/** Which functions and other entities changed between two commits, with how many places depend on each. */
export async function graphDiff(repoDir: string, base: string, headRef = 'HEAD', timeoutMs = 120_000): Promise<EntityChange[]> {
  const out = await entireGraph(repoDir, ['diff', '--base', base, '--head', headRef, '--json'], timeoutMs);
  const parsed = JSON.parse(out) as { files?: { path?: string; language?: string; changes?: { type?: string; kind?: string; name?: string; dependents_count?: number }[] }[] };
  return (parsed.files ?? [])
    .filter((f) => f.path && f.language !== 'JSON')
    .flatMap((f) => (f.changes ?? []).map((c) => ({ file: f.path!, type: c.type ?? '', kind: c.kind ?? '', name: c.name ?? '', dependents: c.dependents_count ?? 0 })));
}

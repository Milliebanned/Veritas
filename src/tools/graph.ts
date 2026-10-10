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

function entireGraph(repoDir: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('entire', ['graph', ...args], { cwd: repoDir, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(new Error(`entire graph ${args[0]} failed: ${err.message.split('\n')[0]}`)) : resolve(stdout),
    );
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

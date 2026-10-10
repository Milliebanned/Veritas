import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createChat, type Chat } from '../llm/client.ts';
import { runToolLoop, type LoopTool, type ToolCallRecord } from '../llm/loop.ts';
import { loadPrompt, type LoadedPrompt } from '../llm/prompts.ts';
import { guarded, note, traced, type SetAttrs } from '../observability/neatlogs.ts';
import { Records, type FindingRecord, type FindingStatus } from '../state/records.ts';
import { fallbackUsage } from '../tools/fallbackImpact.ts';
import { graphCallers, graphEdges, graphSearch, parseEdges, type Caller, type CodeHit, type UsageSite } from '../tools/graph.ts';
import { resolveInside } from '../tools/paths.ts';
import { repoDir } from './intake.ts';
import type { Candidate, IntelSummary } from './intel.ts';
import { usageScore } from './prioritize.ts';
import type { StateHandler } from './states.ts';

/** How impact analysis sees a repository's code. Tests replace the graph with a recording. */
export interface ImpactProvider {
  /** Raw `entire graph edges` output for the repository. */
  edges(repoDir: string): Promise<string>;
  callers(repoDir: string, symbol: string): Promise<Caller[]>;
  search(repoDir: string, query: string): Promise<CodeHit[]>;
}

export const graphProvider: ImpactProvider = { edges: graphEdges, callers: graphCallers, search: graphSearch };

export interface UsageMap {
  /** Why the code graph was not used, when it was not. */
  graphError: string | null;
  packages: Record<string, UsageSite[]>;
}

const SiteVerdict = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().nullable().optional(),
  api: z.string().min(1),
  verdict: z.enum(['affected', 'not_affected', 'unsure']),
  reason: z.string().min(1),
});

const ImpactReport = z.object({
  changed_apis: z.array(z.object({ api: z.string().min(1), change: z.string().min(1), source_url: z.string().min(1) })),
  sites: z.array(SiteVerdict).min(1),
  summary: z.string().min(1),
});

export type ImpactReport = z.infer<typeof ImpactReport>;

export interface ImpactResult {
  report: ImpactReport;
  toolCalls: ToolCallRecord[];
  turns: number;
  costUsd: number;
  /** Which prompt the model ran with: the neatlogs version number, or `local`. */
  promptVersion: string;
}

const MAX_FILE_LINES = 250;
const MAX_SOURCE_CHARS = 24_000;

export function readFileTool(dir: string): LoopTool {
  return {
    name: 'read_file',
    description: `Read a source file from the project. Each line is shown as "<line number>| <text>": everything after the bar and one space is the exact text of the line, including its indentation. Returns at most ${MAX_FILE_LINES} lines; pass start_line to read further.`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the project root' }, start_line: { type: 'integer', minimum: 1 } },
      required: ['path'],
    },
    run: async (args) => {
      const path = await guarded('workspace_path', String(args.path), () => resolveInside(dir, String(args.path)));
      if (!existsSync(path)) throw new Error(`No such file: ${String(args.path)}`);
      const lines = readFileSync(path, 'utf8').split('\n');
      const start = Math.max(1, Number(args.start_line) || 1);
      const shown = lines.slice(start - 1, start - 1 + MAX_FILE_LINES);
      const more = start - 1 + shown.length < lines.length ? `\n[${lines.length - (start - 1 + shown.length)} more lines]` : '';
      // A bar marks where the line number ends. With spaces alone the model could not tell padding from indentation and copied two spaces too many.
      return shown.map((line, i) => `${start + i}| ${line}`).join('\n') + more;
    },
  };
}

export function searchTool(dir: string, provider: ImpactProvider): LoopTool {
  return {
    name: 'search_code',
    description: 'Search the project with the code graph. Describe what you are looking for, or name a function or method (for example "routes that call req.param" or "app.del"). Returns the best-matching functions with file and line.',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 2 } }, required: ['query'] },
    run: async (args) => {
      const hits = await provider.search(dir, String(args.query));
      return hits.length ? hits.map((h) => `${h.file}:${h.line}${h.symbol ? `  ${h.symbol}` : ''}\n    ${h.snippet}`).join('\n') : 'No matches.';
    },
  };
}

export function callersTool(dir: string, provider: ImpactProvider): LoopTool {
  return {
    name: 'find_callers',
    description: 'List the functions that call a named function in this project, from the code graph. Use it to see how far a broken function reaches.',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    run: async (args) => {
      const callers = await provider.callers(dir, String(args.symbol));
      return callers.length ? callers.map((c) => `${c.symbol}  ${c.file}${c.line ? `:${c.line}` : ''}`).join('\n') : 'No callers found.';
    },
  };
}

export function describeRuntime(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { type?: string; engines?: { node?: string } };
  return [
    `Project module system: ${manifest.type === 'module' ? 'ES modules ("type": "module")' : 'CommonJS (no "type": "module" in package.json)'}`,
    `Node.js used to run the project's tests: ${process.version}`,
    manifest.engines?.node ? `Project "engines.node": ${manifest.engines.node}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function userPrompt(dir: string, candidate: Candidate, sources: { url: string; kind: string; excerpt: string | null }[], sites: UsageSite[]): string {
  let budget = MAX_SOURCE_CHARS;
  const excerpts = sources.map((s, i) => {
    const text = (s.excerpt ?? '').slice(0, Math.max(0, budget));
    budget -= text.length;
    return `[${i + 1}] ${s.kind} — ${s.url}\n${text}`;
  });
  const places = sites.map((s) => `- ${s.file}${s.line ? `:${s.line}` : ''}  ${s.kind === 'import' ? `imports "${s.uses}"` : `calls ${s.uses}`}${s.symbol ? ` (in ${s.symbol})` : ''}`);
  return `Package: ${candidate.package}
Upgrade: ${candidate.installed} -> ${candidate.targetVersion ?? 'latest'}

${describeRuntime(dir)}

Excerpts from the package's release notes:

${excerpts.join('\n\n')}

Where the project uses ${candidate.package} (from ${sites[0]?.provider === 'graph' ? 'the code graph' : 'a source scan'}):
${places.join('\n')}`;
}

/** Usage of each package, from the code graph, with the source scan covering anything the graph does not report. */
async function buildUsageMap(dir: string, packages: string[], provider: ImpactProvider): Promise<UsageMap> {
  let edges: string | null = null;
  let graphError: string | null = null;
  try {
    edges = await provider.edges(dir);
  } catch (err) {
    graphError = (err as Error).message;
  }
  const map: UsageMap = { graphError, packages: {} };
  for (const pkg of packages) {
    const fromGraph = edges ? parseEdges(edges, pkg) : [];
    map.packages[pkg] = fromGraph.length ? fromGraph : fallbackUsage(dir, pkg);
  }
  return map;
}

/** Runs the impact analyst as a neatlogs AGENT span linked to the managed prompt version it used. */
async function runImpactAgent<T>(candidate: Candidate, body: (prompt: LoadedPrompt, set: SetAttrs) => Promise<T>): Promise<T> {
  const prompt = await loadPrompt('veritas-impact-analyst');
  return traced(
    'agent.impact',
    'AGENT',
    { package: candidate.package, from: candidate.installed, to: candidate.targetVersion ?? '', prompt_version: prompt.version, prompt_source: prompt.source },
    (set) => body(prompt, set),
    undefined,
    { promptTemplate: prompt.text, version: `${prompt.name}@${prompt.version}` },
  );
}

const uniqueSites = (sites: { file: string; line: number | null; symbol: string | null; provider: string }[]) =>
  [...new Map(sites.map((s) => [`${s.file}:${s.line ?? ''}:${s.symbol ?? ''}`, s])).values()];

export function createImpactHandler(deps: { chat?: Chat; provider?: ImpactProvider } = {}): StateHandler {
  const provider = deps.provider ?? graphProvider;
  return async (ctx) => {
    const dir = repoDir(ctx.investigationId);
    const records = new Records(ctx.db);
    const candidates = ctx.journal.output<IntelSummary>(ctx.investigationId, 'INTEL', 'candidates')?.candidates ?? [];
    const findings = new Map(records.findings(ctx.investigationId).map((f) => [f.id, f] as [string, FindingRecord]));
    const packages = [...new Set(candidates.map((c) => c.package))].sort();
    if (packages.length === 0) return 'PRIORITIZE';

    const usage = await ctx.step('usage_map', { packages }, () =>
      traced('tool.code_graph', 'TOOL', { packages: packages.join(',') }, async (set) => {
        const map = await buildUsageMap(dir, packages, provider);
        set({ provider: map.graphError ? 'fallback' : 'graph', sites: Object.values(map.packages).flat().length });
        return map;
      }),
    );

    for (const candidate of candidates) {
      const finding = findings.get(candidate.findingId);
      const sites = usage.packages[candidate.package] ?? [];
      if (!finding) continue;

      if (sites.length === 0) {
        records.saveImpact(finding.id, { status: 'not_affected', confidence: 1, usageScore: 0, rationale: `${finding.rationale} No source file in this project imports ${candidate.package}.` }, []);
        continue;
      }

      if (candidate.kind !== 'breaking') {
        // A published advisory or a registry deprecation is a fact about the installed version; usage shows where it matters.
        const files = [...new Set(sites.map((s) => s.file))];
        const status: FindingStatus = candidate.kind === 'advisory' && finding.severity !== null ? 'confirmed' : 'potential';
        records.saveImpact(
          finding.id,
          { status, confidence: status === 'confirmed' ? 1 : 0.5, usageScore: usageScore(files.length), rationale: `${finding.rationale} Used in ${files.join(', ')}.` },
          uniqueSites(sites),
        );
        continue;
      }

      const sources = records.sourcesFor(finding.id);
      const result = await ctx.step('impact_reasoning', { finding: finding.id, package: candidate.package, from: candidate.installed, to: candidate.targetVersion }, () =>
        runImpactAgent(candidate, async (prompt, set): Promise<ImpactResult> => {
          const chat = deps.chat ?? createChat(ctx.db, ctx.limits);
          const loop = await runToolLoop<ImpactReport>({
            chat,
            ctx: { investigationId: ctx.investigationId, state: 'IMPACT', step: `impact_reasoning:${candidate.package}` },
            system: prompt.text,
            user: userPrompt(dir, candidate, sources, sites),
            tools: [readFileTool(dir), searchTool(dir, provider), callersTool(dir, provider)],
            submit: {
              name: 'report_impact',
              description: 'Submit the final impact assessment for this package upgrade.',
              parameters: z.toJSONSchema(ImpactReport) as Record<string, unknown>,
              parse: (args) => {
                const report = ImpactReport.parse(args);
                const missing = report.sites.map((s) => s.file).filter((file) => !existsSync(join(dir, file)));
                if (missing.length) throw new Error(`These files do not exist in the project: ${missing.join(', ')}. Use paths relative to the project root.`);
                return report;
              },
            },
            maxToolCalls: ctx.limits.maxToolCallsPerStep,
          });
          const affectedCount = loop.result.sites.filter((s) => s.verdict === 'affected').length;
          set({ tool_calls: loop.toolCalls.length, turns: loop.turns, cost_usd: loop.costUsd, affected_sites: affectedCount, 'neatlogs.agent.cost_usd': loop.costUsd, 'neatlogs.agent.num_turns': loop.turns });
          note('impact of {package}: {affected} affected site(s). {summary}', { package: candidate.package, affected: affectedCount, summary: loop.result.summary });
          return { report: loop.result, toolCalls: loop.toolCalls, turns: loop.turns, costUsd: loop.costUsd, promptVersion: prompt.version };
        }),
      );

      const affected = result.report.sites.filter((s) => s.verdict === 'affected');
      const unsure = result.report.sites.filter((s) => s.verdict === 'unsure');
      const flagged = affected.length ? affected : unsure;
      // A breaking change stays "potential" until a test fails on the new version; that proof is the BASELINE state's job.
      const status: FindingStatus = flagged.length ? 'potential' : 'not_affected';
      const files = [...new Set(flagged.map((s) => s.file))];
      records.saveImpact(
        finding.id,
        { status, confidence: affected.length ? 0.5 : unsure.length ? 0.25 : 1, usageScore: usageScore(flagged.length), rationale: `${result.report.summary}${files.length ? ` Affected: ${files.join(', ')}.` : ''}` },
        uniqueSites(
          flagged.map((s) => ({
            file: s.file,
            line: s.line ?? null,
            symbol: sites.find((u) => u.file === s.file && u.symbol)?.symbol ?? null,
            provider: sites[0]?.provider ?? 'fallback',
          })),
        ),
      );
    }
    return 'PRIORITIZE';
  };
}

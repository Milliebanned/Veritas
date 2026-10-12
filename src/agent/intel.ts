import semver from 'semver';
import { note, traced } from '../observability/neatlogs.ts';
import { Records, type FindingInput, type SourceInput } from '../state/records.ts';
import { fetchAdvisories, type Advisory } from '../tools/advisories.ts';
import { fetchReleaseNotes, type ReleaseNote } from '../tools/githubReleases.ts';
import { needsLockfile, readInventory, type Inventory } from '../tools/manifest.ts';
import { generateLockfile, runNpmAudit, type AuditEntry, type Severity } from '../tools/npmCli.ts';
import { fetchPackageInfo, type GithubRepo, type PackageInfo } from '../tools/npmRegistry.ts';
import { repoDir } from './intake.ts';
import type { RunContext, StateHandler } from './states.ts';

/** The outside world as the inventory and intelligence states see it. Tests replace these with recordings. */
export interface IntelTools {
  readInventory(repoDir: string): Inventory;
  runNpmAudit(repoDir: string, timeoutMs: number): Promise<AuditEntry[]>;
  /** Writes a lockfile for a project that has none. Optional so recorded tests need not provide it. */
  generateLockfile?(repoDir: string, timeoutMs: number): Promise<void>;
  fetchPackageInfo(name: string, installed: string): Promise<PackageInfo>;
  fetchReleaseNotes(repo: GithubRepo, versions: string[]): Promise<ReleaseNote[]>;
  fetchAdvisories(name: string, version: string): Promise<Advisory[]>;
}

export const realTools: IntelTools = { readInventory, runNpmAudit, generateLockfile, fetchPackageInfo, fetchReleaseNotes, fetchAdvisories };

/** A lookup that could not be completed. The investigation continues without it and says so. */
interface Unavailable {
  unavailable: string;
}

export interface Candidate {
  findingId: string;
  package: string;
  kind: FindingInput['kind'];
  installed: string;
  /** Version a fix would move to: the latest for a breaking change, the first fully patched one for an advisory. */
  targetVersion: string | null;
  sources: number;
}

export interface IntelSummary {
  candidates: Candidate[];
  unavailable: string[];
}

/** Severity term of the priority formula (plan section 14). */
const SEVERITY_SCORE: Record<Severity, number> = { critical: 1, high: 0.75, moderate: 0.5, low: 0.25 };
const MAX_MAJORS = 20;

const tool = <T>(name: string, attrs: Record<string, string | number>, fn: () => Promise<T> | T) =>
  traced(`tool.${name}`, 'TOOL', attrs, fn);

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export function createInventoryHandler(tools: IntelTools): StateHandler {
  return async (ctx) => {
    const dir = repoDir(ctx.investigationId);
    const commit = ctx.journal.getInvestigation(ctx.investigationId)?.commit_sha ?? null;

    if (tools.generateLockfile && needsLockfile(dir)) {
      await ctx.step('generate_lockfile', { commit }, () =>
        tool('generate_lockfile', {}, async () => {
          await tools.generateLockfile!(dir, Math.max(ctx.limits.cmdTimeoutMs, 180_000));
          note('the project has no usable package-lock.json (missing or version 1), so one was resolved for this investigation');
          return { generated: true };
        }),
      );
    }
    await ctx.step('read_lockfile', { commit }, () =>
      tool('read_lockfile', {}, () => {
        const inventory = tools.readInventory(dir);
        new Records(ctx.db).saveInventory(ctx.investigationId, inventory.entries);
        return inventory;
      }),
    );
    await ctx.step('npm_audit', { commit }, () =>
      tool('npm_audit', {}, () => withRounds('npm audit', ESSENTIAL_ROUNDS, () => tools.runNpmAudit(dir, ctx.limits.cmdTimeoutMs))),
    );
    return 'INTEL';
  };
}

function breakingFinding(info: PackageInfo, notes: ReleaseNote[]): { finding: FindingInput; sources: SourceInput[] } {
  const majors = info.majorsCrossed.map((m) => m.major).join(', ');
  const esm = info.latestIsEsmOnly ? ' The latest version is published as an ES module only.' : '';
  return {
    finding: {
      package: info.name,
      kind: 'breaking',
      status: 'potential',
      severity: null,
      rationale: `${info.name} ${info.installed} is behind ${info.latest}, crossing major version(s) ${majors}.${esm} Whether this project uses anything that changed is not yet known.`,
    },
    sources: [
      {
        url: info.sourceUrl,
        kind: 'registry',
        excerpt: `latest: ${info.latest}; installed: ${info.installed}; first releases of later majors: ${info.majorsCrossed.map((m) => m.version).join(', ')}`,
        verified: true,
      },
      ...notes.map((n): SourceInput => ({ url: n.url, kind: n.kind, excerpt: `${info.name} ${n.version}\n${n.excerpt}`, verified: true })),
    ],
  };
}

function advisoryFinding(
  entry: AuditEntry,
  installed: string,
  advisories: Advisory[],
): { finding: FindingInput; sources: SourceInput[]; fixVersion: string | null } | null {
  // The GitHub Advisory Database is the source of record; npm audit's own list is the fallback when it was unreachable.
  const reviewed = advisories.filter((a) => a.reviewed);
  const sources: SourceInput[] = advisories.length
    ? advisories.map((a) => ({
        url: a.url,
        kind: 'advisory',
        excerpt: `${a.ghsaId}${a.cveId ? ` / ${a.cveId}` : ''} (${a.severity}${a.reviewed ? '' : ', unreviewed'}): ${a.summary}. Vulnerable: ${a.vulnerableRange ?? 'unknown'}. First patched: ${a.firstPatched ?? 'none'}.`,
        verified: true,
      }))
    : entry.advisories.map((a) => ({
        url: a.url,
        kind: 'advisory',
        excerpt: `${a.ghsaId ?? 'advisory'} (${a.severity}): ${a.title}. Vulnerable: ${a.range}.`,
        verified: true,
      }));
  if (sources.length === 0) return null;

  const severities = reviewed.length ? reviewed.map((a) => a.severity) : entry.advisories.map((a) => a.severity);
  const severity = Math.max(0, ...severities.map((s) => SEVERITY_SCORE[s]));
  const patched = reviewed.map((a) => a.firstPatched).filter((v): v is string => !!v && !!semver.valid(v));
  const allPatched = reviewed.length > 0 && patched.length === reviewed.length;
  const fixVersion = allPatched ? (semver.rsort(patched)[0] ?? null) : entry.fixVersion;
  const count = reviewed.length || entry.advisories.length;
  const where = entry.isDirect ? 'a direct dependency' : 'a transitive dependency';
  return {
    finding: {
      package: entry.package,
      kind: 'advisory',
      status: 'potential',
      severity: severity || null,
      rationale: `${count} published advisor${count === 1 ? 'y affects' : 'ies affect'} ${entry.package}@${installed}, ${where}. ${fixVersion ? `All are fixed from ${fixVersion}.` : 'No single fixed version is published for all of them.'}`,
    },
    sources,
    fixVersion,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roundWaitMs = () => Number(process.env.VERITAS_LOOKUP_WAIT_MS ?? 15_000);
/** Lookups nothing else can stand in for get further rounds, spaced out, after the HTTP layer's own quick retries are spent. */
const ESSENTIAL_ROUNDS = 2;

/** Runs fn, and after a failure waits and tries again for up to `extraRounds` more rounds. */
async function withRounds<T>(what: string, extraRounds: number, fn: () => Promise<T>): Promise<T | Unavailable> {
  for (let round = 0; ; round++) {
    try {
      return await fn();
    } catch (err) {
      if (round >= extraRounds) return { unavailable: `${what}: ${message(err)}` };
      note('{what} failed ({error}); waiting {wait} ms before round {next}', { what, error: message(err), wait: roundWaitMs(), next: round + 2, level: 'warn' });
      await sleep(roundWaitMs());
    }
  }
}

async function lookup<T>(ctx: RunContext, name: string, input: Record<string, unknown>, fn: () => Promise<T>, extraRounds = 0): Promise<T | Unavailable> {
  return ctx.step(name, input, () => tool(name, { package: String(input.name) }, () => withRounds(`${name} for ${String(input.name)}`, extraRounds, fn)));
}

const failed = (value: unknown): value is Unavailable => typeof value === 'object' && value !== null && 'unavailable' in value;

export function createIntelHandler(tools: IntelTools): StateHandler {
  return async (ctx) => {
    const records = new Records(ctx.db);
    const inventory = ctx.journal.output<Inventory>(ctx.investigationId, 'INVENTORY', 'read_lockfile');
    const audit = ctx.journal.output<AuditEntry[] | Unavailable>(ctx.investigationId, 'INVENTORY', 'npm_audit');
    if (!inventory) throw new Error('INTEL needs the inventory from the INVENTORY state');

    const unavailable: string[] = failed(audit) ? [audit.unavailable] : [];
    const candidates: Candidate[] = [];
    const installedOf = new Map(inventory.entries.map((e) => [e.name, e.installed]));

    for (const dep of inventory.entries.filter((e) => e.direct)) {
      const info = await lookup(ctx, 'registry', { name: dep.name, installed: dep.installed }, async () => {
        const fetched = await tools.fetchPackageInfo(dep.name, dep.installed);
        records.setRegistryInfo(ctx.investigationId, dep.name, fetched.latest, fetched.deprecated);
        return fetched;
      }, ESSENTIAL_ROUNDS);
      if (failed(info)) {
        // Without the registry nothing can be concluded about this package. Say so, instead of reporting nothing.
        unavailable.push(info.unavailable);
        records.saveFinding(
          ctx.investigationId,
          { package: dep.name, kind: 'unchecked', status: 'unresolved', severity: null, rationale: `${dep.name}@${dep.installed} could not be checked: the npm registry did not answer after repeated attempts. No conclusion was reached about this package.` },
          [],
        );
        continue;
      }

      if (info.deprecated) {
        const id = records.saveFinding(
          ctx.investigationId,
          { package: dep.name, kind: 'deprecation', status: 'potential', severity: 0.25, rationale: `${dep.name}@${dep.installed} is marked deprecated in the npm registry.` },
          [{ url: info.sourceUrl, kind: 'registry', excerpt: info.deprecated, verified: true }],
        );
        candidates.push({ findingId: id, package: dep.name, kind: 'deprecation', installed: dep.installed, targetVersion: null, sources: 1 });
      }

      if (info.majorsCrossed.length === 0) continue;
      let notes: ReleaseNote[] = [];
      if (info.repository) {
        const versions = info.majorsCrossed.slice(-MAX_MAJORS).map((m) => m.version);
        const repo = info.repository;
        const fetched = await lookup(ctx, 'release_notes', { name: dep.name, versions }, () => tools.fetchReleaseNotes(repo, versions));
        if (failed(fetched)) unavailable.push(fetched.unavailable);
        else notes = fetched;
      }
      const { finding, sources } = breakingFinding(info, notes);
      const id = records.saveFinding(ctx.investigationId, finding, sources);
      candidates.push({ findingId: id, package: dep.name, kind: 'breaking', installed: dep.installed, targetVersion: info.latest, sources: sources.length });
    }

    for (const entry of failed(audit) ? [] : (audit ?? [])) {
      const installed = installedOf.get(entry.package);
      if (!installed || entry.advisories.length === 0) continue; // vulnerable only through another package, which has its own entry
      const fetched = await lookup(ctx, 'advisories', { name: entry.package, version: installed }, () => tools.fetchAdvisories(entry.package, installed));
      if (failed(fetched)) unavailable.push(fetched.unavailable);
      const built = advisoryFinding(entry, installed, failed(fetched) ? [] : fetched);
      if (!built) continue;
      const id = records.saveFinding(ctx.investigationId, built.finding, built.sources);
      candidates.push({ findingId: id, package: entry.package, kind: 'advisory', installed, targetVersion: built.fixVersion, sources: built.sources.length });
    }

    await ctx.step('candidates', { packages: candidates.map((c) => `${c.kind}:${c.package}`) }, (): IntelSummary => ({ candidates, unavailable }));
    return 'IMPACT';
  };
}

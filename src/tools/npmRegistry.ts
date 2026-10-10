import semver from 'semver';
import { getJson, type HttpGet } from './http.ts';

export interface GithubRepo {
  owner: string;
  repo: string;
}

export interface MajorRelease {
  major: number;
  /** First stable version published on this major line. */
  version: string;
  publishedAt: string | null;
}

export interface PackageInfo {
  name: string;
  installed: string;
  latest: string;
  /** Deprecation message for the installed version, when the registry has one. */
  deprecated: string | null;
  repository: GithubRepo | null;
  /** Major lines after the installed version, up to and including the latest. */
  majorsCrossed: MajorRelease[];
  latestIsEsmOnly: boolean;
  latestEngines: string | null;
  sourceUrl: string;
}

interface PackumentVersion {
  deprecated?: string;
  type?: string;
  main?: string;
  exports?: unknown;
  engines?: { node?: string };
}

interface Packument {
  name?: string;
  'dist-tags'?: { latest?: string };
  versions?: Record<string, PackumentVersion>;
  time?: Record<string, string>;
  repository?: string | { url?: string };
}

export const registryUrl = (name: string) => `https://registry.npmjs.org/${name.replace('/', '%2F')}`;

/** Accepts the forms npm allows: full git URLs, `github:owner/repo`, and bare `owner/repo`. */
export function parseGithubRepo(repository: Packument['repository']): GithubRepo | null {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  const match =
    /github\.com[/:]([^/\s]+)\/([^/\s#]+)/.exec(raw) ?? /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

/** A package whose latest version declares "type": "module" and offers no `require` export condition. */
function isEsmOnly(version: PackumentVersion | undefined): boolean {
  if (version?.type !== 'module') return false;
  return !JSON.stringify(version.exports ?? null).includes('"require"');
}

export function parsePackument(doc: unknown, installed: string): PackageInfo {
  const pack = doc as Packument;
  const latest = pack['dist-tags']?.latest;
  if (!pack.name || !latest || !pack.versions) throw new Error('Registry response is missing name, dist-tags.latest or versions');

  const stable = Object.keys(pack.versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .sort(semver.compare);
  const majorsCrossed: MajorRelease[] = [];
  for (const version of stable) {
    const major = semver.major(version);
    if (major <= semver.major(installed) || semver.gt(version, latest)) continue;
    if (majorsCrossed.some((m) => m.major === major)) continue;
    majorsCrossed.push({ major, version, publishedAt: pack.time?.[version] ?? null });
  }

  return {
    name: pack.name,
    installed,
    latest,
    deprecated: pack.versions[installed]?.deprecated ?? null,
    repository: parseGithubRepo(pack.repository),
    majorsCrossed,
    latestIsEsmOnly: isEsmOnly(pack.versions[latest]),
    latestEngines: pack.versions[latest]?.engines?.node ?? null,
    sourceUrl: registryUrl(pack.name),
  };
}

export async function fetchPackageInfo(name: string, installed: string, http?: HttpGet): Promise<PackageInfo> {
  return parsePackument(await getJson(registryUrl(name), {}, http), installed);
}

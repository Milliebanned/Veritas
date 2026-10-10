import semver from 'semver';
import { githubGet, HttpError, type HttpGet } from './http.ts';
import { toSeverity, type Severity } from './npmCli.ts';

export interface Advisory {
  ghsaId: string;
  cveId: string | null;
  severity: Severity;
  summary: string;
  url: string;
  /** True when GitHub has reviewed the advisory. Unreviewed entries are not treated as confirmed. */
  reviewed: boolean;
  vulnerableRange: string | null;
  firstPatched: string | null;
  publishedAt: string | null;
}

interface RawAdvisory {
  ghsa_id: string;
  cve_id?: string | null;
  html_url: string;
  summary?: string;
  type?: string;
  severity?: string;
  published_at?: string | null;
  withdrawn_at?: string | null;
  vulnerabilities?: {
    package?: { ecosystem?: string; name?: string };
    vulnerable_version_range?: string | null;
    first_patched_version?: string | null;
  }[];
}

/** GitHub writes ranges as ">= 4.0.0, < 4.17.21"; semver wants the comma gone. */
function inRange(version: string, range: string | null | undefined): boolean {
  return !!range && semver.satisfies(version, range.replace(/,\s*/g, ' '));
}

/**
 * Keeps the advisories that name `pkg` and have not been withdrawn. An advisory can list
 * several ranges for one package, each with its own fix; the one containing `version` is used.
 */
export function parseAdvisories(json: unknown, pkg: string, version?: string): Advisory[] {
  if (!Array.isArray(json)) throw new Error('GitHub advisories response is not a list');
  const advisories: Advisory[] = [];
  for (const raw of json as RawAdvisory[]) {
    if (raw.withdrawn_at) continue;
    const ranges = raw.vulnerabilities?.filter((v) => v.package?.name === pkg) ?? [];
    const affected = (version && ranges.find((v) => inRange(version, v.vulnerable_version_range))) || ranges[0];
    if (!affected) continue;
    advisories.push({
      ghsaId: raw.ghsa_id,
      cveId: raw.cve_id ?? null,
      severity: toSeverity(raw.severity),
      summary: raw.summary ?? '',
      url: raw.html_url,
      reviewed: raw.type === 'reviewed',
      vulnerableRange: affected.vulnerable_version_range ?? null,
      firstPatched: affected.first_patched_version ?? null,
      publishedAt: raw.published_at ?? null,
    });
  }
  return advisories;
}

export const advisoriesUrl = (pkg: string, version: string) =>
  `https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=${encodeURIComponent(`${pkg}@${version}`)}`;

/** Published advisories from the GitHub Advisory Database that affect `pkg` at `version`. */
export async function fetchAdvisories(pkg: string, version: string, http?: HttpGet): Promise<Advisory[]> {
  const url = advisoriesUrl(pkg, version);
  const res = await githubGet(url, http);
  if (res.status !== 200) throw new HttpError(url, res.status);
  return parseAdvisories(JSON.parse(res.text), pkg, version);
}

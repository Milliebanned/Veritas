import { execFile } from 'node:child_process';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export interface AuditAdvisory {
  ghsaId: string | null;
  title: string;
  url: string;
  severity: Severity;
  range: string;
  cvssScore: number | null;
}

export interface AuditEntry {
  package: string;
  severity: Severity;
  isDirect: boolean;
  range: string;
  /** Version npm would install to clear the entry, when it knows one. */
  fixVersion: string | null;
  fixIsSemverMajor: boolean;
  advisories: AuditAdvisory[];
  /** Other packages this entry is vulnerable through (transitive paths). */
  viaPackages: string[];
}

interface RawVia {
  title?: string;
  url?: string;
  severity?: string;
  range?: string;
  cvss?: { score?: number };
}

interface RawVulnerability {
  name: string;
  severity: string;
  isDirect?: boolean;
  range?: string;
  fixAvailable?: boolean | { version?: string; isSemVerMajor?: boolean };
  via?: (string | RawVia)[];
}

const SEVERITIES: readonly string[] = ['low', 'moderate', 'high', 'critical'];

/** npm audit and OSV say "moderate" where GitHub says "medium"; Veritas uses npm's word. */
export function toSeverity(value: string | undefined): Severity {
  const v = value === 'medium' ? 'moderate' : value;
  return v && SEVERITIES.includes(v) ? (v as Severity) : 'low';
}

export function parseNpmAudit(json: unknown): AuditEntry[] {
  const report = json as { vulnerabilities?: Record<string, RawVulnerability>; error?: { summary?: string } };
  if (report.error) throw new Error(`npm audit failed: ${report.error.summary ?? 'unknown error'}`);
  if (!report.vulnerabilities) throw new Error('npm audit output has no "vulnerabilities" field');

  return Object.values(report.vulnerabilities).map((v) => {
    const fix = typeof v.fixAvailable === 'object' ? v.fixAvailable : null;
    const via = v.via ?? [];
    return {
      package: v.name,
      severity: toSeverity(v.severity),
      isDirect: v.isDirect ?? false,
      range: v.range ?? '*',
      fixVersion: fix?.version ?? null,
      fixIsSemverMajor: fix?.isSemVerMajor ?? false,
      advisories: via
        .filter((entry): entry is RawVia => typeof entry === 'object')
        .map((a) => ({
          ghsaId: /GHSA-[\w-]+/.exec(a.url ?? '')?.[0] ?? null,
          title: a.title ?? '',
          url: a.url ?? '',
          severity: toSeverity(a.severity),
          range: a.range ?? '*',
          cvssScore: a.cvss?.score || null,
        })),
      viaPackages: via.filter((entry): entry is string => typeof entry === 'string'),
    };
  });
}

/**
 * Runs `npm audit --json` against the lockfile. Nothing is installed and no package
 * scripts run. npm exits 1 when it finds vulnerabilities; that is a result, not a failure.
 */
export function runNpmAudit(repoDir: string, timeoutMs = 120_000): Promise<AuditEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'npm',
      ['audit', '--json', '--package-lock-only', '--registry=https://registry.npmjs.org'],
      { cwd: repoDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        try {
          resolve(parseNpmAudit(JSON.parse(stdout)));
        } catch (parseError) {
          reject(err ?? parseError);
        }
      },
    );
  });
}

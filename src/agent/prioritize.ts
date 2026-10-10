import { Records, type FindingRecord } from '../state/records.ts';
import type { IntelSummary } from './intel.ts';
import type { StateHandler } from './states.ts';

export interface PriorityTerms {
  /** 0–1. Advisory: critical 1.0, high 0.75, moderate 0.5, low 0.25. Breaking: 0.75 once a failure is confirmed, 0.5 before. Deprecation: 0.25. */
  severity: number;
  /** 0–1. 0 when the package is not used, otherwise the share of `SITES_FOR_FULL_USAGE` affected sites, capped at 1. */
  usage: number;
  /** 0–1. Confirmed 1.0, potential 0.5, unsure 0.25. */
  confidence: number;
  /** 1 when a fixed version or a code change is known, otherwise 0. */
  fixAvailable: number;
}

export const WEIGHTS = { severity: 0.35, usage: 0.3, confidence: 0.2, fixAvailable: 0.15 } as const;
export const SITES_FOR_FULL_USAGE = 5;
export const UNCONFIRMED_BREAKING_SEVERITY = 0.5;

const clamp = (n: number) => Math.min(1, Math.max(0, n));

export const usageScore = (affectedSites: number) => clamp(affectedSites / SITES_FOR_FULL_USAGE);

/** priority = 0.35·severity + 0.30·usage + 0.20·confidence + 0.15·fixAvailable (plan section 14). */
export function priority(terms: PriorityTerms): number {
  const score =
    WEIGHTS.severity * clamp(terms.severity) +
    WEIGHTS.usage * clamp(terms.usage) +
    WEIGHTS.confidence * clamp(terms.confidence) +
    WEIGHTS.fixAvailable * clamp(terms.fixAvailable);
  return Math.round(score * 1000) / 1000;
}

export function termsFor(finding: FindingRecord, fixKnown: boolean): PriorityTerms {
  return {
    severity: finding.severity ?? (finding.kind === 'breaking' ? UNCONFIRMED_BREAKING_SEVERITY : 0.25),
    usage: finding.usage_score ?? 0,
    confidence: finding.confidence ?? 0.25,
    fixAvailable: fixKnown ? 1 : 0,
  };
}

/** Scores every finding that still matters and records the order they will be worked in. */
export const prioritize: StateHandler = async (ctx) => {
  const records = new Records(ctx.db);
  const candidates = ctx.journal.output<IntelSummary>(ctx.investigationId, 'INTEL', 'candidates')?.candidates ?? [];
  const open = records.findings(ctx.investigationId).filter((f) => f.status !== 'not_affected');

  await ctx.step('score', { findings: open.map((f) => [f.id, f.status, f.usage_score, f.confidence]) }, () =>
    open
      .map((finding) => {
        const candidate = candidates.find((c) => c.findingId === finding.id);
        // A target version is a known fix for an advisory. For a breaking change the fix is a code change, known once affected sites are.
        const fixKnown = finding.kind === 'breaking' ? (finding.usage_score ?? 0) > 0 : !!candidate?.targetVersion;
        const terms = termsFor(finding, fixKnown);
        const score = priority(terms);
        records.setPriority(finding.id, score);
        return { findingId: finding.id, package: finding.package, kind: finding.kind, terms, priority: score };
      })
      .sort((a, b) => b.priority - a.priority),
  );
  return 'PLAN_REPAIR';
};

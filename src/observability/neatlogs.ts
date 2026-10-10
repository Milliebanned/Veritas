import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { flushAllDetailed, getDeliveryDiagnostics, init, log, setTraceOutput, shutdown, trace } from 'neatlogs';

type Kind = 'WORKFLOW' | 'CHAIN' | 'TOOL' | 'AGENT' | 'GUARDRAIL' | 'EVALUATOR';
type Attrs = Record<string, string | number | boolean | undefined>;

/** Optional neatlogs fields for a span: session grouping, the managed prompt in use, and its version. */
export interface SpanExtras {
  sessionId?: string;
  promptTemplate?: string;
  version?: string;
  /** Attributes neatlogs itself understands (for example `neatlogs.guardrail.passed`), set without the `veritas.` prefix. */
  attributes?: Record<string, string | number | boolean>;
}

let enabled = false;

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Starts tracing when NEATLOGS_API_KEY is set. Without it every helper is a plain passthrough.
 * Each run is tagged with the code version and model tier so runs of different versions can be
 * compared in neatlogs, and a processed copy of every span is also written to a local file.
 */
export async function initTracing(workflowName = 'veritas'): Promise<boolean> {
  const apiKey = process.env.NEATLOGS_API_KEY;
  if (!apiKey || enabled) return enabled;

  process.env.NEATLOGS_LOG_SPANS ??= 'true';
  process.env.NEATLOGS_LOG_SPANS_FILE ??= '.veritas/spans/spans.log';
  mkdirSync(dirname(process.env.NEATLOGS_LOG_SPANS_FILE), { recursive: true });

  const commit = gitCommit();
  const release = process.env.VERITAS_RELEASE ?? commit ?? 'dev';
  const tier = process.env.VERITAS_TIER === 'main' ? 'main' : 'fast';
  await init({
    apiKey,
    workflowName,
    captureLogs: true,
    tags: [`release:${release}`, `tier:${tier}`],
    metadata: { release, commit: commit ?? 'unknown', tier },
  });
  enabled = true;
  return enabled;
}

export function tracingEnabled(): boolean {
  return enabled;
}

/** Sends everything still buffered and reports whether neatlogs accepted it. */
export async function shutdownTracing(): Promise<{ delivered: boolean; droppedSpans: number; failedExports: number } | null> {
  if (!enabled) return null;
  const result = await flushAllDetailed(20_000);
  const diagnostics = getDeliveryDiagnostics();
  await shutdown();
  enabled = false;
  return { delivered: result.success, droppedSpans: diagnostics.spanQueueDrops, failedExports: diagnostics.spanExportFailures };
}

/** Lets the body of a span add attributes it only knows once it has run, such as an outcome or a cost. */
export type SetAttrs = (attrs: Attrs) => void;

/**
 * Runs fn inside a named span. The span records `input` (the attributes, unless a fuller
 * input is given) and fn's return value as its output, so a trace shows what went into
 * each step and tool call and what came back. Attributes are prefixed `veritas.` for filtering.
 */
export async function traced<T>(
  name: string,
  kind: Kind,
  attrs: Attrs,
  fn: (set: SetAttrs) => Promise<T> | T,
  input?: unknown,
  extras: SpanExtras = {},
): Promise<T> {
  if (!enabled) return fn(() => undefined);
  const { attributes, ...options } = extras;
  return trace({ name, kind, input: input ?? attrs, ...options }, async (span) => {
    const set: SetAttrs = (more) => {
      for (const [k, v] of Object.entries(more)) {
        if (v !== undefined) span.setAttribute(`veritas.${k}`, v);
      }
    };
    set(attrs);
    if (kind === 'TOOL') span.setAttribute('neatlogs.tool.name', name.replace(/^tool\./, ''));
    for (const [k, v] of Object.entries(attributes ?? {})) span.setAttribute(k, v);
    return fn(set);
  });
}

/**
 * A check that passes or blocks, recorded as a neatlogs GUARDRAIL span so blocked
 * actions (a path outside the workspace, an invalid model answer) are visible as such.
 */
export async function guarded<T>(name: string, input: string, check: () => T): Promise<T> {
  if (!enabled) return check();
  return trace({ name: `guard.${name}`, kind: 'GUARDRAIL', input }, async (span) => {
    span.setAttribute('neatlogs.guardrail.input', input.slice(0, 2000));
    try {
      const result = check();
      span.setAttribute('neatlogs.guardrail.passed', true);
      span.setAttribute('neatlogs.guardrail.output', 'passed');
      return result;
    } catch (err) {
      span.setAttribute('neatlogs.guardrail.passed', false);
      span.setAttribute('neatlogs.guardrail.output', (err as Error).message.slice(0, 2000));
      throw err;
    }
  });
}

/** A timestamped event on the current span: a state change, a retry, a failure, or what the agent decided. */
export function note(message: string, fields: Record<string, string | number | boolean> = {}): void {
  if (enabled) log(message, fields);
}

/** What the trace list shows as this run's result. */
export function traceOutput(value: unknown): void {
  if (enabled) setTraceOutput(value);
}

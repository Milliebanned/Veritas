import { flush, init, shutdown, trace } from 'neatlogs';

type Kind = 'WORKFLOW' | 'CHAIN' | 'TOOL' | 'AGENT';
type Attrs = Record<string, string | number | boolean | undefined>;

let enabled = false;

/** Starts tracing when NEATLOGS_API_KEY is set. Without it every helper is a plain passthrough. */
export async function initTracing(workflowName = 'veritas'): Promise<boolean> {
  const apiKey = process.env.NEATLOGS_API_KEY;
  if (!apiKey || enabled) return enabled;
  await init({ apiKey, workflowName });
  enabled = true;
  return enabled;
}

export function tracingEnabled(): boolean {
  return enabled;
}

export async function shutdownTracing(): Promise<void> {
  if (!enabled) return;
  await flush();
  await shutdown();
  enabled = false;
}

/** Lets the body of a span add attributes it only knows once it has run, such as an outcome or a cost. */
export type SetAttrs = (attrs: Attrs) => void;

/**
 * Runs fn inside a named span. The span records `input` (the attributes, unless a fuller
 * input is given) and fn's return value as its output, so a trace shows what went into
 * each step and tool call and what came back. Attributes are prefixed `veritas.` for filtering.
 */
export async function traced<T>(name: string, kind: Kind, attrs: Attrs, fn: (set: SetAttrs) => Promise<T> | T, input?: unknown): Promise<T> {
  if (!enabled) return fn(() => undefined);
  return trace({ name, kind, input: input ?? attrs }, async (span) => {
    const set: SetAttrs = (more) => {
      for (const [k, v] of Object.entries(more)) {
        if (v !== undefined) span.setAttribute(`veritas.${k}`, v);
      }
    };
    set(attrs);
    return fn(set);
  });
}

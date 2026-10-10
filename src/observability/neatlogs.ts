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

/** Runs fn inside a named span. Attributes are prefixed `veritas.` so they are easy to filter on. */
export async function traced<T>(name: string, kind: Kind, attrs: Attrs, fn: (set: SetAttrs) => Promise<T> | T): Promise<T> {
  if (!enabled) return fn(() => undefined);
  return trace({ name, kind }, async (span) => {
    const set: SetAttrs = (more) => {
      for (const [k, v] of Object.entries(more)) {
        if (v !== undefined) span.setAttribute(`veritas.${k}`, v);
      }
    };
    set(attrs);
    return fn(set);
  });
}

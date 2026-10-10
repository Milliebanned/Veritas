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

/** Runs fn inside a named span. Attributes are prefixed `veritas.` so they are easy to filter on. */
export async function traced<T>(name: string, kind: Kind, attrs: Attrs, fn: () => Promise<T> | T): Promise<T> {
  if (!enabled) return fn();
  return trace({ name, kind }, async (span) => {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) span.setAttribute(`veritas.${k}`, v);
    }
    return fn();
  });
}

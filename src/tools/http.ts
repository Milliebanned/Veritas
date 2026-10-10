import { traced } from '../observability/neatlogs.ts';

export interface HttpResponse {
  status: number;
  text: string;
}

export interface HttpOptions {
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
  /** Base delay between retries; doubled each time. */
  backoffMs?: number;
}

export type HttpGet = (url: string, opts?: HttpOptions) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} returned ${status}`);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const transient = (status: number) => status === 429 || status >= 500;

/**
 * GET with bounded retries for transient failures (network errors, 429, 5xx).
 * Other statuses are returned to the caller, which decides what a 404 means.
 */
export const httpGet: HttpGet = async (url, opts = {}) => {
  const { headers, retries = 3, timeoutMs = 30_000, backoffMs = 500 } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    try {
      // One span per attempt, so a retry and the failure that caused it are both visible in the trace.
      // The body stays out of the span: a registry document can be several megabytes.
      let text = '';
      const summary = await traced('http.get', 'TOOL', { url, attempt: attempt + 1 }, async (set) => {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        set({ status: r.status, retry: attempt > 0 });
        if (transient(r.status)) throw new HttpError(url, r.status);
        text = await r.text();
        return { status: r.status, bytes: text.length };
      });
      return { status: summary.status, text };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
};

/** GET that must succeed with JSON. */
export async function getJson(url: string, opts: HttpOptions = {}, http: HttpGet = httpGet): Promise<unknown> {
  const res = await http(url, opts);
  if (res.status !== 200) throw new HttpError(url, res.status);
  return JSON.parse(res.text);
}

/**
 * GET against the GitHub API or raw content. Sends GITHUB_TOKEN when set; if GitHub
 * rejects the token, the request is repeated without it, since these endpoints are public.
 */
export async function githubGet(url: string, http: HttpGet = httpGet): Promise<HttpResponse> {
  const base = { accept: 'application/vnd.github+json', 'user-agent': 'veritas' };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const res = await http(url, { headers: { ...base, authorization: `Bearer ${token}` } });
    if (res.status !== 401) return res;
  }
  return http(url, { headers: base });
}

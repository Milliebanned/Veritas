import { execFile } from 'node:child_process';

export interface PullRequest {
  url: string;
  number: number;
}

const REPO_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = REPO_URL.exec(url);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : null;
}

/**
 * Pushes one branch from the workspace to GitHub. The token is handed to git through a
 * credential helper that reads it from the environment, so it never appears in a command line.
 */
export function pushBranch(dir: string, repoUrl: string, branch: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$VERITAS_PUSH_TOKEN"; }; f', 'push', '--force', repoUrl, `${branch}:${branch}`],
      { cwd: dir, env: { ...process.env, VERITAS_PUSH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 },
      (err, _stdout, stderr) => (err ? reject(new Error(`git push failed: ${stderr.split('\n').find((l) => l.trim()) ?? err.message}`.replaceAll(token, '***'))) : resolve()),
    );
  });
}

async function api(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'veritas', 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Opens a pull request for `branch` against the repository's default branch, or returns the one already open for it. */
export async function openPullRequest(owner: string, repo: string, branch: string, title: string, body: string, token: string): Promise<PullRequest> {
  const info = await api(`/repos/${owner}/${repo}`, token);
  if (info.status !== 200) throw new Error(`Cannot read ${owner}/${repo} (HTTP ${info.status}): ${info.json.message ?? ''}`);
  const created = await api(`/repos/${owner}/${repo}/pulls`, token, { method: 'POST', body: { title, body, head: branch, base: info.json.default_branch } });
  if (created.status === 201) return { url: created.json.html_url, number: created.json.number };
  if (created.status === 422) {
    const existing = await api(`/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`, token);
    if (existing.status === 200 && existing.json[0]) return { url: existing.json[0].html_url, number: existing.json[0].number };
  }
  throw new Error(`Could not open a pull request (HTTP ${created.status}): ${created.json.message ?? ''}`);
}

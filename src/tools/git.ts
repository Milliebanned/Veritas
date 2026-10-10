import { execFileSync } from 'node:child_process';

const IDENTITY = ['-c', 'user.name=Veritas', '-c', 'user.email=veritas@localhost'];

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

export const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');

/** Starts (or restarts) a branch at a commit and checks it out, discarding anything uncommitted. */
export function startBranch(cwd: string, branch: string, at: string): void {
  git(cwd, 'checkout', '--quiet', '--force', '-B', branch, at);
  git(cwd, 'clean', '-fd', '--quiet');
}

/** Commits everything that changed. Returns the new commit, or null when nothing changed. */
export function commitAll(cwd: string, message: string): string | null {
  git(cwd, 'add', '--all');
  if (!git(cwd, 'status', '--porcelain')) return null;
  git(cwd, ...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', message);
  return head(cwd);
}

/** Returns the working tree to a commit, so a failed attempt leaves nothing behind. */
export function resetTo(cwd: string, commit: string): void {
  git(cwd, 'reset', '--quiet', '--hard', commit);
  git(cwd, 'clean', '-fd', '--quiet');
}

export const diffBetween = (cwd: string, base: string, headRef = 'HEAD', paths: string[] = []) =>
  git(cwd, 'diff', '--no-color', base, headRef, '--', ...(paths.length ? paths : ['.', ':(exclude)package-lock.json']));

export const changedFiles = (cwd: string, base: string, headRef = 'HEAD') =>
  git(cwd, 'diff', '--name-only', base, headRef).split('\n').filter(Boolean);

import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { traced } from '../observability/neatlogs.ts';
import type { StateHandler } from './states.ts';

const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;
const SKIPPED = new Set(['node_modules', '.git']);

export const workspaceRoot = () => resolve(process.env.VERITAS_WORKSPACE_DIR ?? '.veritas/workspaces');

/** Where an investigation's private copy of the repository lives. The original is never touched. */
export const repoDir = (investigationId: string) => join(workspaceRoot(), investigationId, 'repo');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Puts a private copy of the repository at `dest` and returns the commit it starts from.
 * Accepts a public GitHub URL or a local directory. A local directory is copied without
 * node_modules and committed to a fresh git repository, so later changes can be diffed and reverted.
 */
export function prepareWorkspace(source: string, dest: string): { commitSha: string; origin: 'github' | 'local' } {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });

  if (GITHUB_URL.test(source)) {
    git(dirname(dest), 'clone', '--depth', '1', '--', source, dest);
    return { commitSha: git(dest, 'rev-parse', 'HEAD'), origin: 'github' };
  }
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Not a public GitHub URL or a local directory: ${source}`);
  }

  cpSync(resolve(source), dest, { recursive: true, filter: (path) => !SKIPPED.has(basename(path)) });
  git(dest, 'init', '--quiet');
  appendFileSync(join(dest, '.git', 'info', 'exclude'), 'node_modules/\n');
  git(dest, 'add', '--all');
  git(dest, '-c', 'user.name=Veritas', '-c', 'user.email=veritas@localhost', 'commit', '--quiet', '--no-verify', '-m', 'Baseline');
  return { commitSha: git(dest, 'rev-parse', 'HEAD'), origin: 'local' };
}

export const intake: StateHandler = async (ctx) => {
  const { commitSha } = await ctx.step('clone', { repo: ctx.repoUrl }, () =>
    traced('tool.git_clone', 'TOOL', { repo: ctx.repoUrl }, () => prepareWorkspace(ctx.repoUrl, repoDir(ctx.investigationId))),
  );
  ctx.journal.setCommit(ctx.investigationId, commitSha);
  return 'INVENTORY';
};

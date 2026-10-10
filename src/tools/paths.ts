import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class PathEscape extends Error {
  constructor(path: string) {
    super(`Path is outside the workspace: ${path}`);
    this.name = 'PathEscape';
  }
}

/**
 * Resolves a path given by the model against the workspace root and refuses anything that
 * lands outside it, including through `..`, an absolute path, or a symlink.
 */
export function resolveInside(root: string, path: string): string {
  const base = realpathSync(root);
  const target = resolve(base, path);
  const real = existsSync(target) ? realpathSync(target) : target;
  const rel = relative(base, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PathEscape(path);
  if (rel.split(sep).includes('.git')) throw new PathEscape(path);
  return real;
}

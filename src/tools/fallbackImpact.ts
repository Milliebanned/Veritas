import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { belongsTo, type UsageSite } from './graph.ts';

const SOURCE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const SPECIFIER = /(?:\brequire\s*\(|\bimport\s*\(|\bfrom\s+|\bimport\s+)\s*['"]([^'"]+)['"]/g;

export function listSourceFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(root, path));
    else if (entry.isFile() && SOURCE.test(entry.name)) files.push(relative(root, path));
  }
  return files.sort();
}

/** Import sites of `pkg` in one file's text: require(), import, dynamic import() and export … from. */
export function scanImports(file: string, text: string, pkg: string): UsageSite[] {
  const sites: UsageSite[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier && belongsTo(specifier, pkg)) {
        sites.push({ file, line: index + 1, symbol: null, uses: specifier, kind: 'import', provider: 'fallback' });
      }
    }
  });
  return sites;
}

/**
 * Finds where a package is imported by reading the source text. Used when the code graph is
 * unavailable or reports nothing for a package, so a missing graph never reads as "not used".
 */
export function fallbackUsage(repoDir: string, pkg: string): UsageSite[] {
  return listSourceFiles(repoDir).flatMap((file) => scanImports(file, readFileSync(join(repoDir, file), 'utf8'), pkg));
}

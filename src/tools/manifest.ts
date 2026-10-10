import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InventoryEntry {
  name: string;
  installed: string;
  direct: boolean;
  dev: boolean;
  /** The range written in package.json, for direct dependencies. */
  spec: string | null;
}

export interface Inventory {
  projectName: string | null;
  lockfileVersion: number;
  entries: InventoryEntry[];
}

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>;
}

const MARKER = 'node_modules/';

/**
 * Builds the dependency inventory from package.json and package-lock.json alone,
 * so nothing from the target repository is installed or executed.
 * When a package is installed at several versions, the top-level one is reported.
 */
export function parseInventory(manifest: Manifest, lock: Lockfile): Inventory {
  if (!lock.packages) {
    throw new Error(`Unsupported package-lock.json (lockfileVersion ${lock.lockfileVersion ?? 'unknown'}); version 2 or 3 is required`);
  }
  const prod = { ...manifest.optionalDependencies, ...manifest.dependencies };
  const dev = manifest.devDependencies ?? {};
  const entries = new Map<string, InventoryEntry & { depth: number }>();

  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path.startsWith(MARKER) || !pkg.version || pkg.link) continue;
    const name = path.slice(path.lastIndexOf(MARKER) + MARKER.length);
    const depth = path.split(MARKER).length - 1;
    const seen = entries.get(name);
    if (seen && seen.depth <= depth) continue;
    const spec = prod[name] ?? dev[name] ?? null;
    entries.set(name, {
      name,
      installed: pkg.version,
      direct: depth === 1 && spec !== null,
      dev: depth === 1 && !(name in prod) && name in dev,
      spec: depth === 1 ? spec : null,
      depth,
    });
  }

  return {
    projectName: manifest.name ?? null,
    lockfileVersion: lock.lockfileVersion ?? 0,
    entries: [...entries.values()]
      .map(({ depth: _depth, ...entry }) => entry)
      .sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name)),
  };
}

export function readInventory(repoDir: string): Inventory {
  const manifestPath = join(repoDir, 'package.json');
  const lockPath = join(repoDir, 'package-lock.json');
  if (!existsSync(manifestPath)) throw new Error('No package.json at the repository root');
  if (!existsSync(lockPath)) throw new Error('No package-lock.json at the repository root; only npm projects with a lockfile are supported');
  return parseInventory(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest,
    JSON.parse(readFileSync(lockPath, 'utf8')) as Lockfile,
  );
}

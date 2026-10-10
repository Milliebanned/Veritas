import { createPrompt, getPrompt, saveAsVersion } from 'neatlogs';
import { tracingEnabled } from '../observability/neatlogs.ts';

/**
 * The agent's prompts. These are the copies checked into the repository; the copies the
 * agent actually runs with are managed in neatlogs (versioned, with a `production` label),
 * so a prompt can be changed, compared across versions and rolled back without a code change.
 * The local copy is used when neatlogs is not configured or cannot be reached.
 */
export const LOCAL_PROMPTS = {
  'veritas-impact-analyst': `You are the impact analyst inside Veritas, a tool that checks whether a dependency upgrade breaks a specific JavaScript or TypeScript project.

You are given one package, the upgrade being considered, excerpts from the package's own release notes, and the places in the project that use the package. Decide, for each place, whether the upgrade breaks it.

Rules:
- Read the code before you judge it. Use read_file on every file that uses the package. Never describe code you have not read.
- A site is "affected" only when a change documented in the excerpts applies to what that code actually does, or when the package's module format changes in a way the project's module system cannot load as written.
- A site is "not_affected" when it only uses parts of the package that still work the same way after the upgrade. A file that imports the package is not affected just because it imports it.
- Use "unsure" when the excerpts do not settle it. Do not guess.
- Removed or changed APIs are often methods on objects the package creates (for example a method on an app, request or response object). Check method calls, not only the import line.
- List only changes that the excerpts state. Give the source URL each one came from.
- Report every file that uses the package, including the ones that are not affected.

Module formats in Node.js:
- A CommonJS file loads packages with require(). An ES module uses import.
- When a package becomes ES-module-only: on Node.js 22 and later, require() of it returns the module namespace object, so a default export is found under .default and named exports are properties; code that calls the required value directly, or calls methods that lived on the old default export, fails with "is not a function". On Node.js versions before 22, require() of it throws ERR_REQUIRE_ESM.
- A deep import such as require('pkg/lib/x') fails when the package's "exports" no longer lists that path.

When you have read the code, call report_impact once.`,
} as const;

export type PromptName = keyof typeof LOCAL_PROMPTS;

export interface LoadedPrompt {
  name: PromptName;
  text: string;
  /** neatlogs prompt version, or `local` when the checked-in copy was used. */
  version: string;
  source: 'neatlogs' | 'local';
}

const LABEL = 'production';

/** The prompt labelled `production` in neatlogs, falling back to the checked-in copy. */
export async function loadPrompt(name: PromptName): Promise<LoadedPrompt> {
  if (tracingEnabled()) {
    try {
      const prompt = await getPrompt(name, { label: LABEL });
      if (prompt.content) return { name, text: prompt.content, version: String(prompt.version), source: 'neatlogs' };
    } catch {
      // Not published yet, or neatlogs is unreachable: the checked-in copy keeps the agent running.
    }
  }
  return { name, text: LOCAL_PROMPTS[name], version: 'local', source: 'local' };
}

export interface PublishResult {
  name: PromptName;
  action: 'created' | 'new_version' | 'unchanged';
  version: number;
}

/** Publishes the checked-in prompts to neatlogs. A prompt whose text already matches is left alone. */
export async function publishPrompts(commitMessage: string): Promise<PublishResult[]> {
  const results: PublishResult[] = [];
  for (const name of Object.keys(LOCAL_PROMPTS) as PromptName[]) {
    const content = LOCAL_PROMPTS[name];
    let current: Awaited<ReturnType<typeof getPrompt>> | null = null;
    try {
      current = await getPrompt(name, { label: LABEL, cacheTtlMs: 0 });
    } catch {
      current = null;
    }
    if (current?.content === content) {
      results.push({ name, action: 'unchanged', version: current.version });
    } else if (current) {
      const saved = await saveAsVersion(name, { content, labels: [LABEL], commitMessage });
      results.push({ name, action: 'new_version', version: saved.version });
    } else {
      const created = await createPrompt({ name, content, labels: [LABEL], commitMessage });
      results.push({ name, action: 'created', version: created.version });
    }
  }
  return results;
}

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAdvisories } from '../src/tools/advisories.ts';
import { breakingExcerpt, extractChangelogSection, fetchReleaseNotes, findGuideLinks, htmlToText, parseReleases, pickGuides } from '../src/tools/githubReleases.ts';
import { findUpgradeGuides } from '../src/tools/upgradeGuides.ts';
import { githubGet, httpGet, type HttpGet } from '../src/tools/http.ts';
import { parseInventory, readInventory } from '../src/tools/manifest.ts';
import { parseNpmAudit } from '../src/tools/npmCli.ts';
import { parseGithubRepo, parsePackument } from '../src/tools/npmRegistry.ts';

// Fixtures are real responses recorded on 2026-10-10, trimmed to the fields Veritas reads.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('manifest', () => {
  it('reads direct and transitive dependencies from a real lockfile', () => {
    const inventory = readInventory('bench/cases/02-node-fetch-esm-only/repo');
    expect(inventory.projectName).toBe('weather-client');
    expect(inventory.entries.filter((e) => e.direct)).toEqual([
      { name: 'node-fetch', installed: '2.7.0', direct: true, dev: false, spec: '2.7.0' },
    ]);
    expect(inventory.entries.find((e) => e.name === 'whatwg-url')).toMatchObject({ direct: false, spec: null });
  });

  it('reports the top-level copy when a package is installed twice, and marks dev dependencies', () => {
    const inventory = parseInventory(
      { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } },
      {
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/a': { version: '1.2.0' },
          'node_modules/b': { version: '2.1.0', dev: true },
          'node_modules/a/node_modules/b': { version: '1.0.0' },
          'node_modules/@scope/c': { version: '3.0.0' },
        },
      },
    );
    expect(inventory.entries).toEqual([
      { name: 'a', installed: '1.2.0', direct: true, dev: false, spec: '^1.0.0' },
      { name: 'b', installed: '2.1.0', direct: true, dev: true, spec: '^2.0.0' },
      { name: '@scope/c', installed: '3.0.0', direct: false, dev: false, spec: null },
    ]);
  });

  it('rejects a lockfile without a packages map', () => {
    expect(() => parseInventory({}, { lockfileVersion: 1 })).toThrow('lockfileVersion 1');
  });
});

describe('npm registry', () => {
  it('finds the majors crossed and the repository', () => {
    const info = parsePackument(fixture('packument-chalk.json'), '4.1.2');
    expect(info).toMatchObject({
      name: 'chalk',
      latest: '6.0.1',
      deprecated: null,
      repository: { owner: 'chalk', repo: 'chalk' },
      latestIsEsmOnly: true,
    });
    expect(info.majorsCrossed.map((m) => m.version)).toEqual(['5.0.0', '6.0.0']);
    expect(info.majorsCrossed[0]?.publishedAt).toMatch(/^2021-/);
  });

  it('reports no majors crossed when already on the latest major', () => {
    expect(parsePackument(fixture('packument-chalk.json'), '6.0.0').majorsCrossed).toEqual([]);
  });

  it('reads the deprecation message of the installed version', () => {
    expect(parsePackument(fixture('packument-request.json'), '2.88.2').deprecated).toMatch(/request has been deprecated/);
  });

  it('parses the repository forms npm allows', () => {
    expect(parseGithubRepo({ url: 'git+https://github.com/node-fetch/node-fetch.git' })).toEqual({ owner: 'node-fetch', repo: 'node-fetch' });
    expect(parseGithubRepo({ url: 'git://github.com/socketio/socket.io.git' })).toEqual({ owner: 'socketio', repo: 'socket.io' });
    expect(parseGithubRepo('github:expressjs/express')).toEqual({ owner: 'expressjs', repo: 'express' });
    expect(parseGithubRepo('lodash/lodash')).toEqual({ owner: 'lodash', repo: 'lodash' });
    expect(parseGithubRepo({ url: 'https://gitlab.com/a/b.git' })).toBeNull();
    expect(parseGithubRepo(undefined)).toBeNull();
  });
});

describe('npm audit', () => {
  it('parses advisories for a direct dependency', () => {
    const [entry, ...rest] = parseNpmAudit(fixture('audit-lodash.json'));
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ package: 'lodash', severity: 'high', isDirect: true });
    expect(entry?.advisories).toHaveLength(6);
    expect(entry?.advisories[0]).toMatchObject({ ghsaId: 'GHSA-35jh-r3h4-6jhm', severity: 'high', range: '<4.17.21' });
  });

  it('returns nothing for a clean tree and throws on an npm error', () => {
    expect(parseNpmAudit(fixture('audit-clean.json'))).toEqual([]);
    expect(() => parseNpmAudit({ error: { summary: 'ENOLOCK' } })).toThrow('ENOLOCK');
  });
});

describe('github advisories', () => {
  it('keeps the entry for the package, normalises severity and drops withdrawn advisories', () => {
    const advisories = parseAdvisories(fixture('advisories-lodash.json'), 'lodash');
    // The recording holds 7 advisories; GHSA-8p5q-j9m2-g8wr was withdrawn in 2021.
    expect(advisories).toHaveLength(6);
    expect(advisories.map((a) => a.ghsaId)).not.toContain('GHSA-8p5q-j9m2-g8wr');
    expect(advisories.find((a) => a.ghsaId === 'GHSA-p6mc-m468-83gw')).toMatchObject({
      cveId: 'CVE-2020-8203',
      severity: 'high',
      reviewed: true,
      vulnerableRange: '>= 3.7.0, < 4.17.19',
      firstPatched: '4.17.19',
    });
    expect(advisories.find((a) => a.ghsaId === 'GHSA-29mw-wpgm-hmr9')?.severity).toBe('moderate');
  });

  it('ignores advisories that do not name the package', () => {
    expect(parseAdvisories(fixture('advisories-lodash.json'), 'left-pad')).toEqual([]);
  });

  it('uses the range that contains the installed version when an advisory lists several', () => {
    const raw = [{ ghsa_id: 'GHSA-w5hq-g745-h8pq', html_url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq', type: 'reviewed', severity: 'medium', vulnerabilities: [
      { package: { name: 'uuid' }, vulnerable_version_range: '>= 12.0.0, < 12.0.1', first_patched_version: '12.0.1' },
      { package: { name: 'uuid' }, vulnerable_version_range: '< 11.1.1', first_patched_version: '11.1.1' },
    ] }];
    expect(parseAdvisories(raw, 'uuid', '3.4.0')).toMatchObject([{ vulnerableRange: '< 11.1.1', firstPatched: '11.1.1' }]);
    expect(parseAdvisories(raw, 'uuid', '12.0.0')).toMatchObject([{ firstPatched: '12.0.1' }]);
  });

  it('marks an advisory GitHub has not reviewed', () => {
    const raw = [{ ghsa_id: 'GHSA-xxxx-xxxx-xxxx', html_url: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx', type: 'unreviewed', severity: 'medium', vulnerabilities: [{ package: { name: 'p' }, vulnerable_version_range: '< 2.0.0', first_patched_version: null }] }];
    expect(parseAdvisories(raw, 'p')).toMatchObject([{ reviewed: false, severity: 'moderate', firstPatched: null }]);
  });
});

describe('release notes', () => {
  it('reads versions from tags and extracts the breaking section', () => {
    const releases = parseReleases(fixture('releases-chalk.json'));
    expect(releases.map((r) => r.version)).toContain('5.0.0');
    const v5 = releases.find((r) => r.version === '5.0.0');
    const excerpt = breakingExcerpt(v5?.body ?? '');
    expect(excerpt.startsWith('### Breaking')).toBe(true);
    expect(excerpt).toContain('This package is now pure ESM');
    expect(excerpt.length).toBeLessThanOrEqual(2000);
  });

  it('falls back to the start of the notes when nothing is marked breaking', () => {
    expect(breakingExcerpt('Fixed a typo.\n\nThanks all.')).toBe('Fixed a typo.\n\nThanks all.');
  });

  it('stops the breaking section at the next heading', () => {
    expect(breakingExcerpt('## 8.0.0\n\n### ⚠ BREAKING CHANGES\n\n- deep requires removed\n\n### Features\n\n- more')).toBe(
      '### ⚠ BREAKING CHANGES\n\n- deep requires removed',
    );
  });

  it('cuts one version out of a changelog in either heading style', () => {
    const hashed = '# Changelog\n\n## [8.0.0](https://x/compare) (2020-04-29)\n\n- removed deep requires\n\n### [7.0.3](https://x)\n\n- fix\n';
    expect(extractChangelogSection(hashed, '8.0.0')).toBe('## [8.0.0](https://x/compare) (2020-04-29)\n\n- removed deep requires');
    const underlined = '5.0.0 / 2024-09-10\n=========================\n  * remove:\n    - `app.del` - use `app.delete`\n\n4.21.0 / 2024-09-11\n==========\n  * deps\n';
    expect(extractChangelogSection(underlined, '5.0.0')).toBe('5.0.0 / 2024-09-10\n=========================\n  * remove:\n    - `app.del` - use `app.delete`');
    expect(extractChangelogSection(hashed, '9.0.0')).toBeNull();
  });

  it('finds migration guide links and reads the guide from its first mention of removals', async () => {
    const body = 'See the [migration guide](https://example.com/guide/migrating-5.html), the [blog](https://example.com/blog) and [how to upgrade](https://github.com/o/r/issues/659).';
    expect(findGuideLinks(body)).toEqual(['https://example.com/guide/migrating-5.html']);
    expect(htmlToText('<nav>menu</nav><h2>Removed</h2><p>app.del() is gone &amp; so is <code>req.param()</code></p><script>x()</script>')).toBe('Removed\napp.del() is gone & so is req.param()');

    const http: HttpGet = async (url) => {
      if (url.includes('/releases?')) return { status: 200, text: JSON.stringify([{ tag_name: 'v5.0.0', html_url: 'https://github.com/o/r/releases/tag/v5.0.0', body }]) };
      if (url === 'https://example.com/guide/migrating-5.html') return { status: 200, text: '<html><body><p>Intro.</p><h2>Removed methods</h2><p>app.del()</p></body></html>' };
      return { status: 404, text: '' };
    };
    const notes = await fetchReleaseNotes({ owner: 'o', repo: 'r' }, ['5.0.0'], http);
    expect(notes.map((n) => [n.kind, n.url])).toEqual([
      ['release_notes', 'https://github.com/o/r/releases/tag/v5.0.0'],
      ['migration_guide', 'https://example.com/guide/migrating-5.html'],
    ]);
    expect(notes[1]?.excerpt).toBe('Removed methods\napp.del()');
  });

  it('does not follow guide links to addresses that are not public https hosts', async () => {
    const seen: string[] = [];
    const http: HttpGet = async (url) => {
      seen.push(url);
      if (url.includes('/releases?')) return { status: 200, text: JSON.stringify([{ tag_name: 'v2.0.0', html_url: 'https://github.com/o/r/releases/tag/v2.0.0', body: '[upgrade](https://169.254.169.254/latest) [migrate](https://localhost/x)' }]) };
      return url.includes('/git/trees/') ? { status: 200, text: JSON.stringify({ tree: [] }) } : { status: 200, text: 'removed things' };
    };
    const notes = await fetchReleaseNotes({ owner: 'o', repo: 'r' }, ['2.0.0'], http);
    expect(notes.map((n) => n.kind)).toEqual(['release_notes']);
    // Only GitHub's own API was contacted: the releases list and the repository file list.
    expect(seen.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
  });

  it('finds upgrade guides kept as files in the repository', async () => {
    const tree = { tree: [{ path: 'README.md', type: 'blob' }, { path: 'docs/v3-UPGRADE-GUIDE.md', type: 'blob' }, { path: 'docs/v2-UPGRADE-GUIDE.md', type: 'blob' }, { path: 'src/migrate.js', type: 'blob' }, { path: 'MIGRATION.md', type: 'blob' }] };
    const seen: string[] = [];
    const get = async (url: string) => {
      seen.push(url);
      if (url.includes('/git/trees/')) return { status: 200, text: JSON.stringify(tree) };
      return url.endsWith('v2-UPGRADE-GUIDE.md') ? { status: 404, text: '' } : { status: 200, text: `guide at ${url.split('/HEAD/')[1]}` };
    };
    const guides = await findUpgradeGuides('o', 'r', get);
    expect(guides).toEqual([
      { url: 'https://github.com/o/r/blob/HEAD/MIGRATION.md', text: 'guide at MIGRATION.md' },
      { url: 'https://github.com/o/r/blob/HEAD/docs/v3-UPGRADE-GUIDE.md', text: 'guide at docs/v3-UPGRADE-GUIDE.md' },
    ]);
    expect(seen.some((u) => u.endsWith('src/migrate.js'))).toBe(false);
    expect(await findUpgradeGuides('o', 'r', async () => { throw new Error('offline'); })).toEqual([]);
    expect(await findUpgradeGuides('o', 'r', async () => ({ status: 404, text: '' }))).toEqual([]);
  });

  it('keeps only the guides for the majors being crossed', () => {
    const guides = ['docs/v2-UPGRADE-GUIDE.md', 'docs/v3-UPGRADE-GUIDE.md', 'MIGRATION.md', 'docs/migrating-to-5.md'].map((path) => ({ url: `https://github.com/o/r/blob/HEAD/${path}`, text: path }));
    expect(pickGuides(guides, ['3.0.0'], 5).map((g) => [g.text, g.version])).toEqual([['docs/v3-UPGRADE-GUIDE.md', '3.0.0'], ['MIGRATION.md', '3.0.0']]);
    expect(pickGuides(guides, ['4.0.0', '5.0.0'], 5).map((g) => [g.text, g.version])).toEqual([['MIGRATION.md', '5.0.0'], ['docs/migrating-to-5.md', '5.0.0']]);
    expect(pickGuides(guides, ['3.0.0'])).toHaveLength(2);
  });

  it('adds a repository upgrade guide to the notes even when the release does not link to it', async () => {
    const http: HttpGet = async (url) => {
      if (url.includes('/releases?')) return { status: 200, text: JSON.stringify([{ tag_name: 'v3.0.0', html_url: 'https://github.com/o/r/releases/tag/v3.0.0', body: 'Now ESM only. See the changelog.' }]) };
      if (url.includes('/git/trees/')) return { status: 200, text: JSON.stringify({ tree: [{ path: 'docs/v3-UPGRADE-GUIDE.md', type: 'blob' }] }) };
      if (url.endsWith('/HEAD/docs/v3-UPGRADE-GUIDE.md')) return { status: 200, text: '## The `timeout` option was removed.\nUse AbortSignal.' };
      return { status: 404, text: '' };
    };
    const notes = await fetchReleaseNotes({ owner: 'o', repo: 'r' }, ['3.0.0'], http);
    expect(notes.map((n) => [n.kind, n.version, n.url])).toEqual([
      ['release_notes', '3.0.0', 'https://github.com/o/r/releases/tag/v3.0.0'],
      ['migration_guide', '3.0.0', 'https://github.com/o/r/blob/HEAD/docs/v3-UPGRADE-GUIDE.md'],
    ]);
    expect(notes[1]?.excerpt).toContain('`timeout` option was removed');
  });

  it('uses the release when it has notes and the changelog when it does not', async () => {
    const http: HttpGet = async (url) => {
      if (url.includes('/releases?')) return { status: 200, text: JSON.stringify([{ tag_name: 'v2.0.0', html_url: 'https://github.com/o/r/releases/tag/v2.0.0', body: '### Breaking\n- two' }]) };
      if (url.endsWith('/HEAD/CHANGELOG.md')) return { status: 200, text: '## 3.0.0\n\n### BREAKING CHANGES\n\n- three\n\n## 2.0.0\n\n- two\n' };
      return { status: 404, text: '' };
    };
    const notes = await fetchReleaseNotes({ owner: 'o', repo: 'r' }, ['2.0.0', '3.0.0', '4.0.0'], http);
    expect(notes).toEqual([
      { version: '2.0.0', url: 'https://github.com/o/r/releases/tag/v2.0.0', kind: 'release_notes', excerpt: '### Breaking\n- two', publishedAt: null },
      { version: '3.0.0', url: 'https://github.com/o/r/blob/HEAD/CHANGELOG.md', kind: 'changelog', excerpt: '### BREAKING CHANGES\n\n- three', publishedAt: null },
    ]);
  });
});

describe('http', () => {
  it('retries transient failures and then succeeds', async () => {
    const original = globalThis.fetch;
    const statuses = [503, 429, 200];
    let calls = 0;
    globalThis.fetch = (async () => new Response('ok', { status: statuses[calls++] })) as typeof fetch;
    try {
      expect(await httpGet('https://example.test', { backoffMs: 1 })).toEqual({ status: 200, text: 'ok' });
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('gives up after the retry limit', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 500 }); }) as typeof fetch;
    try {
      await expect(httpGet('https://example.test', { backoffMs: 1, retries: 2 })).rejects.toThrow('returned 500');
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('repeats a GitHub request without the token when the token is rejected', async () => {
    const before = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'bad';
    const seen: (string | undefined)[] = [];
    const http: HttpGet = async (_url, opts) => {
      seen.push(opts?.headers?.authorization);
      return { status: opts?.headers?.authorization ? 401 : 200, text: '[]' };
    };
    try {
      expect((await githubGet('https://api.github.com/x', http)).status).toBe(200);
      expect(seen).toEqual(['Bearer bad', undefined]);
    } finally {
      if (before === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = before;
    }
  });
});

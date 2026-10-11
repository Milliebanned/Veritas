import { githubGet, httpGet, HttpError, type HttpGet } from './http.ts';
import type { GithubRepo } from './npmRegistry.ts';
import { findUpgradeGuides } from './upgradeGuides.ts';

export interface ReleaseNote {
  version: string;
  url: string;
  kind: 'release_notes' | 'changelog' | 'migration_guide';
  /** The part of the notes that describes breaking changes, or the start of the notes when none is marked. */
  excerpt: string;
  publishedAt: string | null;
}

interface Release {
  version: string;
  url: string;
  body: string;
  publishedAt: string | null;
}

interface RawRelease {
  tag_name?: string;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  published_at?: string | null;
}

const CHANGELOG_FILES = ['CHANGELOG.md', 'History.md', 'HISTORY.md', 'CHANGES.md'];
const MAX_RELEASE_PAGES = 3;
const VERSION_IN_TAG = /(\d+\.\d+\.\d+(?:-[\w.]+)?)$/;
const HASH_HEADING = /^#{1,4}\s*\[?v?(\d+\.\d+\.\d+)/;
const PLAIN_VERSION = /^v?(\d+\.\d+\.\d+)\b/;
const UNDERLINE = /^[=-]{3,}\s*$/;
const BREAKING_HEADING = /^\s*(#{1,6}|\*\*)\s*[^a-z]*breaking/i;
const ANY_HEADING = /^#{1,6}\s/;
const MARKDOWN_LINK = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
const GUIDE = /migrat|upgrad/i;
const MAX_GUIDE_CHARS = 8000;

/** Tags look like `v5.0.0`, `5.0.0` or `pkg@5.0.0`; drafts and tags without a version are dropped. */
export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) throw new Error('GitHub releases response is not a list');
  const releases: Release[] = [];
  for (const raw of json as RawRelease[]) {
    const version = VERSION_IN_TAG.exec(raw.tag_name ?? '')?.[1];
    if (!version || raw.draft || !raw.html_url) continue;
    releases.push({ version, url: raw.html_url, body: raw.body ?? '', publishedAt: raw.published_at ?? null });
  }
  return releases;
}

function clip(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > maxChars && kept.length > 0) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join('\n').trim();
}

/** Returns the section headed "Breaking…" when the notes have one, otherwise the start of the notes. */
export function breakingExcerpt(body: string, maxChars = 2000): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => BREAKING_HEADING.test(line));
  if (start === -1) return clip(lines, maxChars);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => ANY_HEADING.test(line) && !BREAKING_HEADING.test(line));
  return clip([lines[start]!, ...(end === -1 ? rest : rest.slice(0, end))], maxChars);
}

/**
 * Cuts one version's section out of a changelog. Understands `## [8.0.0]`-style headings
 * and the underlined `5.0.0 / 2024-09-10` style used by older projects.
 */
export function extractChangelogSection(text: string, version: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headingVersion = (i: number): string | null => {
    const hash = HASH_HEADING.exec(lines[i] ?? '')?.[1];
    if (hash) return hash;
    return UNDERLINE.test(lines[i + 1] ?? '') ? (PLAIN_VERSION.exec(lines[i] ?? '')?.[1] ?? null) : null;
  };
  const start = lines.findIndex((_line, i) => headingVersion(i) === version);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (headingVersion(i)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** Links in release notes that point at a migration or upgrade guide. */
export function findGuideLinks(body: string): string[] {
  const links = new Set<string>();
  for (const [, text, url] of body.matchAll(MARKDOWN_LINK)) {
    // Issue and pull request pages are discussion, not documentation.
    if (/github\.com\/[^/]+\/[^/]+\/(issues|pull)\//.test(url ?? '')) continue;
    if (text && url && (GUIDE.test(text) || GUIDE.test(url))) links.add(url);
  }
  return [...links];
}

/** Readable text of an HTML page: scripts, styles and tags removed, entities for common characters decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|section)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Only public https hosts by name: a release note must not be able to point Veritas at an internal address. */
function isPublicHttps(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname.includes('.') && !/^[\d.]+$/.test(hostname) && !hostname.startsWith('[') && !hostname.endsWith('.local') && !hostname.endsWith('.internal');
  } catch {
    return false;
  }
}

/** The guide's text from the first mention of removed or breaking behaviour, capped. */
async function fetchGuide(url: string, http: HttpGet = httpGet): Promise<string | null> {
  if (!isPublicHttps(url)) return null;
  const res = await http(url, { headers: { 'user-agent': 'veritas' } });
  if (res.status !== 200) return null;
  const text = /<html|<body|<div/i.test(res.text) ? htmlToText(res.text) : res.text;
  const start = text.search(/\b(removed|breaking)\b/i);
  return text.slice(start === -1 ? 0 : start, (start === -1 ? 0 : start) + MAX_GUIDE_CHARS).trim() || null;
}

async function fetchReleases(repo: GithubRepo, wanted: Set<string>, http?: HttpGet): Promise<Release[]> {
  const found: Release[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100&page=${page}`;
    const res = await githubGet(url, http);
    if (res.status === 404) break;
    if (res.status !== 200) throw new HttpError(url, res.status);
    const raw = JSON.parse(res.text) as unknown[];
    found.push(...parseReleases(raw));
    if (raw.length < 100 || [...wanted].every((v) => found.some((r) => r.version === v))) break;
  }
  return found;
}

async function fetchChangelog(repo: GithubRepo, http?: HttpGet): Promise<{ text: string; url: string } | null> {
  for (const file of CHANGELOG_FILES) {
    const res = await githubGet(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${file}`, http);
    if (res.status === 200) {
      return { text: res.text, url: `https://github.com/${repo.owner}/${repo.repo}/blob/HEAD/${file}` };
    }
  }
  return null;
}

/**
 * Notes for the given versions: the GitHub release when it has a body, otherwise the
 * matching section of the repository's changelog. Versions with neither are omitted.
 * When a release links to a migration guide, the guide is read as well, because projects
 * often keep the list of removed APIs there and not in the release itself.
 */
export async function fetchReleaseNotes(repo: GithubRepo, versions: string[], http?: HttpGet): Promise<ReleaseNote[]> {
  const releases = await fetchReleases(repo, new Set(versions), http);
  const notes: ReleaseNote[] = [];
  let changelog: { text: string; url: string } | null | undefined;

  for (const version of versions) {
    const release = releases.find((r) => r.version === version && r.body.trim());
    if (release) {
      notes.push({ version, url: release.url, kind: 'release_notes', excerpt: breakingExcerpt(release.body), publishedAt: release.publishedAt });
      for (const link of findGuideLinks(release.body).slice(0, 1)) {
        const guide = await fetchGuide(link, http).catch(() => null);
        if (guide) notes.push({ version, url: link, kind: 'migration_guide', excerpt: guide, publishedAt: null });
      }
      continue;
    }
    if (changelog === undefined) changelog = await fetchChangelog(repo, http);
    const section = changelog && extractChangelogSection(changelog.text, version);
    if (changelog && section) {
      notes.push({ version, url: changelog.url, kind: 'changelog', excerpt: breakingExcerpt(section), publishedAt: null });
    }
  }

  // Upgrade guides kept as files in the repository. A release note can be two lines long and
  // leave the removed options to a guide it never links to by that name.
  const seen = new Set(notes.map((n) => n.url));
  const guides = await findUpgradeGuides(repo.owner, repo.repo, (url) => githubGet(url, http));
  for (const guide of pickGuides(guides, versions).filter((g) => !seen.has(g.url))) {
    notes.push({ version: guide.version, url: guide.url, kind: 'migration_guide', excerpt: guide.text.trim().slice(0, MAX_GUIDE_CHARS), publishedAt: null });
  }
  return notes;
}

/**
 * Keeps the guides that concern the majors being crossed. A guide whose path names a major
 * (`v3-UPGRADE-GUIDE.md`) is kept only for that major; one without a number applies to all.
 */
export function pickGuides(guides: { url: string; text: string }[], versions: string[], max = 2): { url: string; text: string; version: string }[] {
  const majors = new Map(versions.map((v) => [v.split('.')[0]!, v]));
  const latest = versions.at(-1) ?? '';
  const picked: { url: string; text: string; version: string }[] = [];
  for (const guide of guides) {
    const named = /(?:^|[^\d.])v?(\d+)(?:\.x)?[^\d]*(?:upgrad|migrat)|(?:upgrad|migrat)[^\d]*?v?(\d+)/i.exec(guide.url.split('/blob/HEAD/')[1] ?? '');
    const major = named?.[1] ?? named?.[2];
    if (major && !majors.has(major)) continue;
    picked.push({ ...guide, version: major ? majors.get(major)! : latest });
  }
  return picked.slice(0, max);
}

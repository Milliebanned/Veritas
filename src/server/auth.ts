import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../state/db.ts';

export interface Session {
  id: string;
  github_login: string;
  avatar_url: string | null;
  github_token: string;
}

const clientId = () => process.env.GITHUB_CLIENT_ID;
const clientSecret = () => process.env.GITHUB_CLIENT_SECRET;

/** Sign-in with GitHub is on when an OAuth app is configured. */
export const githubEnabled = () => Boolean(clientId() && clientSecret());

function cookies(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) out[name] = decodeURIComponent(rest.join('='));
  }
  return out;
}

const setCookie = (reply: FastifyReply, name: string, value: string, maxAgeSeconds: number) =>
  reply.header('set-cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`);

export function sessionOf(db: Db, request: FastifyRequest): Session | null {
  const id = cookies(request).veritas_session;
  if (!id) return null;
  return (db.prepare('SELECT id, github_login, avatar_url, github_token FROM sessions WHERE id = ?').get(id) as Session | undefined) ?? null;
}

async function github(path: string, token: string): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'veritas' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return res.json();
}

/** The signed-in person's public JavaScript and TypeScript repositories, most recently pushed first. */
export async function listRepos(session: Session): Promise<{ full_name: string; url: string; description: string | null; language: string | null; pushed_at: string }[]> {
  const repos = (await github('/user/repos?visibility=public&affiliation=owner&sort=pushed&per_page=60', session.github_token)) as any[];
  return repos
    .filter((r) => !r.archived && (r.language === 'JavaScript' || r.language === 'TypeScript'))
    .map((r) => ({ full_name: r.full_name, url: r.html_url, description: r.description, language: r.language, pushed_at: r.pushed_at }));
}

export function registerAuth(app: FastifyInstance, db: Db): void {
  // Step 1: send the person to GitHub. `public_repo` is what opening a pull request on a public repository needs.
  app.get('/auth/github', async (_request, reply) => {
    if (!githubEnabled()) return reply.code(404).send({ error: 'Sign-in with GitHub is not configured' });
    const state = randomBytes(16).toString('hex');
    setCookie(reply, 'veritas_oauth_state', state, 600);
    const params = new URLSearchParams({ client_id: clientId()!, scope: 'public_repo', state, allow_signup: 'true' });
    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // Step 2: GitHub sends them back with a code, which is exchanged for a token and kept server-side.
  app.get('/auth/github/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    if (!code || !state || state !== cookies(request).veritas_oauth_state) return reply.code(400).send({ error: 'Sign-in could not be verified. Please try again.' });
    const exchange = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId(), client_secret: clientSecret(), code }),
      signal: AbortSignal.timeout(20_000),
    });
    const token = ((await exchange.json()) as { access_token?: string }).access_token;
    if (!token) return reply.code(400).send({ error: 'GitHub did not grant access. Please try again.' });
    const user = await github('/user', token);
    const id = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (id, github_login, avatar_url, github_token, created_at) VALUES (?, ?, ?, ?, ?)').run(id, user.login, user.avatar_url ?? null, token, new Date().toISOString());
    setCookie(reply, 'veritas_session', id, 60 * 60 * 24 * 7);
    return reply.redirect('/#/app');
  });

  app.post('/auth/logout', async (request, reply) => {
    const id = cookies(request).veritas_session;
    if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    setCookie(reply, 'veritas_session', '', 0);
    return { ok: true };
  });
}

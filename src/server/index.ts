import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { handlers } from '../agent/handlers.ts';
import { Orchestrator } from '../agent/orchestrator.ts';
import { buildReport, renderMarkdown } from '../agent/report.ts';
import { activeModel, usageFor } from '../llm/client.ts';
import { initTracing, shutdownTracing } from '../observability/neatlogs.ts';
import { openDb } from '../state/db.ts';
import { Journal, type Investigation } from '../state/journal.ts';
import { parseRepoUrl } from '../tools/github.ts';
import { ApprovalError, decide, getApproval } from './approval.ts';
import { githubEnabled, listRepos, registerAuth, sessionOf, type Session } from './auth.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const root = fileURLToPath(new URL('../..', import.meta.url));
const db = openDb();
const journal = new Journal(db);
const orchestrator = new Orchestrator({ db, handlers });
const accessToken = process.env.VERITAS_ACCESS_TOKEN;
const admins = new Set((process.env.VERITAS_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const userDailyLimit = Number(process.env.VERITAS_USER_DAILY_LIMIT ?? 5);
const dailyLimit = Number(process.env.VERITAS_DAILY_LIMIT ?? 60);
const demoDir = join(root, 'bench', 'cases');

/**
 * How people get in. With a GitHub OAuth app configured, they sign in with GitHub and see their
 * own investigations. Without one, a shared access token (if set) guards the API.
 */
const mode: 'github' | 'token' | 'open' = githubEnabled() ? 'github' : accessToken ? 'token' : 'open';

interface Caller {
  session: Session | null;
  admin: boolean;
}

function callerOf(request: FastifyRequest): Caller | null {
  if (mode === 'github') {
    const session = sessionOf(db, request);
    return session ? { session, admin: admins.has(session.github_login.toLowerCase()) } : null;
  }
  if (mode === 'token') return request.headers['x-veritas-token'] === accessToken ? { session: null, admin: true } : null;
  return { session: null, admin: true };
}

const canSee = (caller: Caller, inv: Investigation) => caller.admin || (caller.session !== null && inv.owner === caller.session.github_login);

/** One investigation runs at a time; the rest wait their turn. */
let queue: Promise<unknown> = Promise.resolve();
const active = new Set<string>();
function enqueue(id: string): void {
  active.add(id);
  queue = queue
    .then(() => orchestrator.run(id))
    .catch((err) => app.log.error({ investigation: id, err: err instanceof Error ? err.message : String(err) }, 'investigation failed'))
    .finally(() => active.delete(id));
}

const app = Fastify({ logger: { level: 'info' } });
registerAuth(app, db);

const PUBLIC = new Set(['/api/me', '/api/public']);
app.addHook('onRequest', async (request, reply) => {
  const path = request.url.split('?')[0]!;
  if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
  if (!callerOf(request)) return reply.code(401).send({ error: mode === 'github' ? 'Sign in with GitHub to continue' : 'Access token required' });
});

const summary = (id: string) => {
  try {
    const report = buildReport(db, id);
    return { verdict: report.verdict, headline: report.headline, counts: report.counts, packages: [...new Set(report.findings.map((f) => f.package))] };
  } catch {
    return null;
  }
};

const startedToday = (owner?: string) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return owner
    ? (db.prepare('SELECT COUNT(*) AS n FROM investigations WHERE started_at > ? AND owner = ?').get(since, owner) as { n: number }).n
    : (db.prepare('SELECT COUNT(*) AS n FROM investigations WHERE started_at > ?').get(since) as { n: number }).n;
};

app.get('/api/me', async (request) => {
  const caller = callerOf(request);
  return {
    mode,
    signed_in: caller !== null,
    user: caller?.session ? { login: caller.session.github_login, avatar: caller.session.avatar_url } : null,
    admin: caller?.admin ?? false,
    model: activeModel(),
    sandbox: process.env.VERITAS_SANDBOX ?? 'docker',
    daily_limit: mode === 'github' ? userDailyLimit : null,
    used_today: caller?.session ? startedToday(caller.session.github_login) : null,
  };
});

/** Headline numbers for the landing page, read from the committed benchmark result. */
app.get('/api/public', async () => {
  const file = join(root, 'evidence', 'bench', 'server-v1-haiku.json');
  if (!existsSync(file)) return { benchmark: null };
  const s = (JSON.parse(readFileSync(file, 'utf8')) as { summary: Record<string, any> }).summary;
  return { benchmark: { cases: s.cases, verdicts_correct: s.verdicts_correct, repair_success: s.repair_success, false_positives: s.false_positives_on_controls, cost_usd: s.cost_usd, duration_s: s.total_duration_s, ran_at: s.ran_at, model: s.model } };
});

app.get('/api/repos', async (request, reply) => {
  const caller = callerOf(request)!;
  if (!caller.session) return [];
  try {
    return await listRepos(caller.session);
  } catch (err) {
    return reply.code(502).send({ error: `Could not list your repositories: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.get('/api/examples', async (request) => {
  const caller = callerOf(request)!;
  if (!caller.admin || !existsSync(demoDir)) return [];
  return readdirSync(demoDir).filter((d) => existsSync(join(demoDir, d, 'repo'))).sort().map((d) => ({ name: d, path: join('bench', 'cases', d, 'repo') }));
});

app.get('/api/investigations', async (request) => {
  const caller = callerOf(request)!;
  return journal
    .listInvestigations()
    .filter((inv) => canSee(caller, inv))
    .slice(0, 60)
    .map((inv) => {
      const done = inv.status === 'awaiting_approval' || inv.status === 'done';
      return { ...inv, running: active.has(inv.id), summary: done ? summary(inv.id) : null, approval: getApproval(db, inv.id) };
    });
});

app.post('/api/investigations', async (request, reply) => {
  const caller = callerOf(request)!;
  const repo = String((request.body as { repo?: unknown } | null)?.repo ?? '').trim();
  const isGithub = parseRepoUrl(repo) !== null;
  const local = resolve(root, repo);
  const isLocal = caller.admin && !isGithub && repo !== '' && local.startsWith(root) && existsSync(local) && statSync(local).isDirectory();
  if (!isGithub && !isLocal) return reply.code(400).send({ error: 'Give the URL of a public GitHub repository, for example https://github.com/owner/repo' });
  // Each investigation spends model budget, so signed-in use is rationed.
  if (mode === 'github' && !caller.admin && startedToday(caller.session!.github_login) >= userDailyLimit) {
    return reply.code(429).send({ error: `You have used your ${userDailyLimit} investigations for today.` });
  }
  if (startedToday() >= dailyLimit) return reply.code(429).send({ error: 'Veritas has reached its limit for today. Please try again tomorrow.' });
  const inv = orchestrator.start(isGithub ? repo : local, caller.session?.github_login ?? null);
  enqueue(inv.id);
  return reply.code(201).send({ id: inv.id });
});

/** Loads an investigation the caller is allowed to see, or answers 404. */
function load(request: FastifyRequest): Investigation | null {
  const inv = journal.getInvestigation((request.params as { id: string }).id);
  return inv && canSee(callerOf(request)!, inv) ? inv : null;
}

app.get('/api/investigations/:id', async (request, reply) => {
  const inv = load(request);
  if (!inv) return reply.code(404).send({ error: 'Unknown investigation' });
  let report = null;
  try {
    report = buildReport(db, inv.id);
  } catch {
    report = null;
  }
  return {
    investigation: inv,
    running: active.has(inv.id),
    steps: journal.steps(inv.id).map(({ id, state, name, status, attempt, duration_ms, error, started_at }) => ({ id, state, name, status, attempt, duration_ms, error, started_at })),
    report,
    usage: usageFor(db, inv.id),
    approval: getApproval(db, inv.id),
  };
});

app.get('/api/investigations/:id/report.md', async (request, reply) => {
  const inv = load(request);
  if (!inv) return reply.code(404).send({ error: 'Unknown investigation' });
  return reply.type('text/markdown; charset=utf-8').send(renderMarkdown(buildReport(db, inv.id)));
});

app.post('/api/investigations/:id/resume', async (request, reply) => {
  const inv = load(request);
  if (!inv) return reply.code(404).send({ error: 'Unknown investigation' });
  if (active.has(inv.id)) return reply.code(409).send({ error: 'Already running' });
  if (inv.status !== 'failed' && inv.status !== 'running') return reply.code(409).send({ error: `Investigation is ${inv.status}` });
  enqueue(inv.id);
  return { id: inv.id };
});

for (const decision of ['approve', 'reject'] as const) {
  app.post(`/api/investigations/:id/${decision}`, async (request, reply) => {
    const inv = load(request);
    if (!inv) return reply.code(404).send({ error: 'Unknown investigation' });
    try {
      // A signed-in person's pull request is opened with their own GitHub access, on their own repository.
      const token = callerOf(request)!.session?.github_token ?? process.env.GITHUB_TOKEN;
      return await decide(db, inv.id, decision === 'approve' ? 'approved' : 'rejected', token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(err instanceof ApprovalError ? 409 : 502).send({ error: message });
    }
  });
}

await app.register(fastifyStatic, { root: join(root, 'web') });
app.setNotFoundHandler((request, reply) => (request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));

await initTracing();
const port = Number(process.env.PORT ?? 3210);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await shutdownTracing();
    process.exit(0);
  });
}

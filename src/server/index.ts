import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { handlers } from '../agent/handlers.ts';
import { Orchestrator } from '../agent/orchestrator.ts';
import { buildReport, renderMarkdown } from '../agent/report.ts';
import { activeModel, usageFor } from '../llm/client.ts';
import { initTracing, shutdownTracing } from '../observability/neatlogs.ts';
import { openDb } from '../state/db.ts';
import { Journal } from '../state/journal.ts';
import { parseRepoUrl } from '../tools/github.ts';
import { ApprovalError, decide, getApproval } from './approval.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const root = fileURLToPath(new URL('../..', import.meta.url));
const db = openDb();
const journal = new Journal(db);
const orchestrator = new Orchestrator({ db, handlers });
const accessToken = process.env.VERITAS_ACCESS_TOKEN;
const allowLocal = process.env.VERITAS_ALLOW_LOCAL === '1';
const demoDir = join(root, 'bench', 'cases');

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

// A shared token keeps strangers from spending the model budget on a public server.
app.addHook('onRequest', async (request, reply) => {
  if (!accessToken || !request.url.startsWith('/api/')) return;
  const given = request.headers['x-veritas-token'] ?? (request.query as Record<string, string> | undefined)?.token;
  if (given !== accessToken) return reply.code(401).send({ error: 'Access token required' });
});

const summary = (id: string) => {
  try {
    const report = buildReport(db, id);
    return { verdict: report.verdict, headline: report.headline, counts: report.counts };
  } catch {
    return null;
  }
};

app.get('/api/config', async () => ({
  model: activeModel(),
  sandbox: process.env.VERITAS_SANDBOX ?? 'docker',
  allow_local: allowLocal,
  examples: allowLocal && existsSync(demoDir) ? readdirSync(demoDir).filter((d) => existsSync(join(demoDir, d, 'repo'))).sort().map((d) => ({ name: d, path: join('bench', 'cases', d, 'repo') })) : [],
}));

app.get('/api/investigations', async () =>
  journal.listInvestigations().map((inv) => {
    const done = inv.status === 'awaiting_approval' || inv.status === 'done';
    return { ...inv, running: active.has(inv.id), summary: done ? summary(inv.id) : null, approval: getApproval(db, inv.id) };
  }),
);

app.post('/api/investigations', async (request, reply) => {
  const repo = String((request.body as { repo?: unknown } | null)?.repo ?? '').trim();
  const isGithub = parseRepoUrl(repo) !== null;
  const local = resolve(root, repo);
  const isLocal = allowLocal && !isGithub && repo !== '' && local.startsWith(root) && existsSync(local) && statSync(local).isDirectory();
  if (!isGithub && !isLocal) return reply.code(400).send({ error: 'Give the URL of a public GitHub repository, for example https://github.com/owner/repo' });
  const inv = orchestrator.start(isGithub ? repo : local);
  enqueue(inv.id);
  return reply.code(201).send({ id: inv.id });
});

app.get('/api/investigations/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const inv = journal.getInvestigation(id);
  if (!inv) return reply.code(404).send({ error: 'Unknown investigation' });
  let report = null;
  try {
    report = buildReport(db, id);
  } catch {
    report = null;
  }
  return {
    investigation: inv,
    running: active.has(id),
    steps: journal.steps(id).map(({ id: stepId, state, name, status, attempt, duration_ms, error, started_at }) => ({ id: stepId, state, name, status, attempt, duration_ms, error, started_at })),
    report,
    usage: usageFor(db, id),
    approval: getApproval(db, id),
  };
});

app.get('/api/investigations/:id/report.md', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!journal.getInvestigation(id)) return reply.code(404).send({ error: 'Unknown investigation' });
  return reply.type('text/markdown; charset=utf-8').send(renderMarkdown(buildReport(db, id)));
});

app.post('/api/investigations/:id/resume', async (request, reply) => {
  const { id } = request.params as { id: string };
  const inv = journal.getInvestigation(id);
  if (!inv) return reply.code(404).send({ error: 'Unknown investigation' });
  if (active.has(id)) return reply.code(409).send({ error: 'Already running' });
  if (inv.status !== 'failed' && inv.status !== 'running') return reply.code(409).send({ error: `Investigation is ${inv.status}` });
  enqueue(id);
  return { id };
});

for (const decision of ['approve', 'reject'] as const) {
  app.post(`/api/investigations/:id/${decision}`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await decide(db, id, decision === 'approve' ? 'approved' : 'rejected');
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

import { spawn } from 'node:child_process';

export interface RunRequest {
  /** Directory the command runs in; inside a container it is the only host directory mounted. */
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
  /** Installs need the registry; tests run with the network off. Only the container sandbox can enforce this. */
  network: boolean;
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export type Sandbox = (request: RunRequest) => Promise<RunResult>;

const MAX_OUTPUT = 400_000;
const IMAGE = process.env.VERITAS_SANDBOX_IMAGE ?? 'node:24-bookworm-slim';

/** Only what a build needs. API keys and tokens in Veritas's own environment never reach repository code. */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: 'true', NO_COLOR: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

function execute(command: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env: scrubbedEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      // The command runs in its own process group so that its children are stopped with it.
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const finish = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      resolve({ exitCode, output: output.slice(0, MAX_OUTPUT) + extra, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (err) => finish(null, `\n${err.message}`));
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

/** Runs the command directly on this machine. For development with repositories you wrote yourself; nothing isolates it. */
export const localSandbox: Sandbox = ({ cwd, command, args, timeoutMs }) => execute(command, args, cwd, timeoutMs);

/** Arguments for running a command in a throwaway container that can see only the workspace. */
export function dockerArgs(request: RunRequest): string[] {
  return [
    'run', '--rm',
    '--network', request.network ? 'bridge' : 'none',
    '--cpus', '2', '--memory', '2g', '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    // Run as the workspace's owner, not root, so files the container writes can be cleaned up and committed afterwards.
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '-e', 'CI=true', '-e', 'NO_COLOR=1', '-e', 'HOME=/tmp',
    '-v', `${request.cwd}:/work`, '-w', '/work',
    IMAGE, request.command, ...request.args,
  ];
}

/** Runs the command in a container: no host files beyond the workspace, no secrets, and no network unless asked for. */
export const dockerSandbox: Sandbox = (request) => execute('docker', dockerArgs(request), request.cwd, request.timeoutMs + 30_000);

/** `VERITAS_SANDBOX=local` selects the unisolated runner; the default is the container. */
export function selectSandbox(mode = process.env.VERITAS_SANDBOX ?? 'docker'): Sandbox {
  if (mode === 'local') return localSandbox;
  if (mode === 'docker') return dockerSandbox;
  throw new Error(`Unknown VERITAS_SANDBOX "${mode}"; use "docker" or "local"`);
}

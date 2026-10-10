const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface Limits {
  maxAttempts: number;
  cmdTimeoutMs: number;
  investigationTimeoutMs: number;
  maxToolCallsPerStep: number;
  maxTokens: number;
}

export function loadLimits(): Limits {
  return {
    maxAttempts: num('VERITAS_MAX_ATTEMPTS', 3),
    cmdTimeoutMs: num('VERITAS_CMD_TIMEOUT_MS', 5 * 60_000),
    investigationTimeoutMs: num('VERITAS_INVESTIGATION_TIMEOUT_MS', 30 * 60_000),
    maxToolCallsPerStep: num('VERITAS_MAX_TOOL_CALLS', 12),
    maxTokens: num('VERITAS_MAX_TOKENS', 400_000),
  };
}

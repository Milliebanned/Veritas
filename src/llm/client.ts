import { wrapOpenAI } from 'neatlogs';
import OpenAI from 'openai';
import type { ChatCompletionMessage, ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionToolChoiceOption } from 'openai/resources/chat/completions';
import type { Limits } from '../agent/limits.ts';
import { traced } from '../observability/neatlogs.ts';
import type { Db } from '../state/db.ts';

export interface LlmCallContext {
  investigationId: string;
  state: string;
  step: string;
}

export interface ChatRequest {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption;
  maxTokens?: number;
}

export interface ChatResult {
  message: ChatCompletionMessage;
  promptTokens: number;
  completionTokens: number;
  /** Cost reported by the LiteLLM proxy for this call, in USD. Null when the proxy did not report one. */
  costUsd: number | null;
}

export type Chat = (request: ChatRequest, ctx: LlmCallContext) => Promise<ChatResult>;

export class TokenBudgetExceeded extends Error {
  constructor(used: number, limit: number) {
    super(`Investigation used ${used} tokens, over its limit of ${limit}`);
    this.name = 'TokenBudgetExceeded';
  }
}

/** `VERITAS_TIER=main` selects the scored-run model; anything else uses the cheaper development model. */
export function activeModel(): string {
  return process.env.VERITAS_TIER === 'main'
    ? (process.env.VERITAS_MODEL ?? 'claude-sonnet-4.6')
    : (process.env.VERITAS_MODEL_FAST ?? 'claude-haiku');
}

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export function usageFor(db: Db, investigationId: string): Usage {
  return db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens, COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM llm_calls WHERE investigation_id = ?`,
    )
    .get(investigationId) as unknown as Usage;
}

/**
 * Model access through the hackathon LiteLLM endpoint. Every call is traced by neatlogs,
 * recorded with its tokens and cost, and refused once the investigation's token limit is spent.
 */
export function createChat(db: Db, limits: Limits): Chat {
  // The proxy reports cost in response headers, which the SDK does not surface, so they are read here.
  let lastCost: number | null = null;
  let lastSplit: { prompt?: number; completion?: number } = {};
  const client = wrapOpenAI(
    new OpenAI({
      baseURL: process.env.LITELLM_BASE_URL,
      apiKey: process.env.LITELLM_API_KEY,
      maxRetries: 3,
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        const header = (name: string) => {
          const value = Number(res.headers.get(name));
          return res.ok && res.headers.has(name) && Number.isFinite(value) ? value : undefined;
        };
        lastCost = header('x-litellm-response-cost') ?? null;
        lastSplit = { prompt: header('x-litellm-response-cost-input'), completion: header('x-litellm-response-cost-output') };
        return res;
      },
    }),
  );
  const record = db.prepare(
    'INSERT INTO llm_calls (investigation_id, state, step, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  return async (request, ctx) => {
    const used = usageFor(db, ctx.investigationId);
    if (used.promptTokens + used.completionTokens >= limits.maxTokens) {
      throw new TokenBudgetExceeded(used.promptTokens + used.completionTokens, limits.maxTokens);
    }
    const model = activeModel();
    // The wrapped client traces the call itself; this span adds the cost, which neatlogs does not price for LiteLLM model names.
    return traced(`llm.${ctx.step.split(':')[0]}`, 'CHAIN', { model, state: ctx.state, step: ctx.step }, async (set) => {
      const t0 = Date.now();
      const res = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: request.maxTokens ?? 2000,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' } : {}),
      });
      const message = res.choices[0]?.message;
      if (!message) throw new Error('Model returned no message');
      const promptTokens = res.usage?.prompt_tokens ?? 0;
      const completionTokens = res.usage?.completion_tokens ?? 0;
      const costUsd = lastCost;
      record.run(ctx.investigationId, ctx.state, ctx.step, model, promptTokens, completionTokens, costUsd, Date.now() - t0, new Date().toISOString());
      set({
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cost_usd: costUsd ?? undefined,
        latency_ms: Date.now() - t0,
        // The same cost under neatlogs' own attribute names. The model-call span itself is created
        // inside the wrapped client and cannot be reached from here, so they go on this enclosing span.
        'neatlogs.llm.cost_usd': costUsd ?? undefined,
        'neatlogs.llm.cost.prompt': lastSplit.prompt,
        'neatlogs.llm.cost.completion': lastSplit.completion,
      });
      return { message, promptTokens, completionTokens, costUsd };
    }, { messages: request.messages.length, tool_choice: request.toolChoice ?? 'auto' });
  };
}

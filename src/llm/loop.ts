import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { guarded, note, traced } from '../observability/neatlogs.ts';
import type { Chat, LlmCallContext } from './client.ts';

export interface LoopTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string> | string;
}

export interface SubmitTool<T> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Validates the arguments. Throws with a message the model can act on. */
  parse(args: unknown): T;
}

export interface LoopOptions<T> {
  chat: Chat;
  ctx: LlmCallContext;
  system: string;
  user: string;
  tools: LoopTool[];
  submit: SubmitTool<T>;
  /** Upper bound on tool calls, the final submission included. */
  maxToolCalls: number;
  /**
   * Keeps the last `calls` tool calls for the tools that produce the result (for a repair, the
   * edit tool). Without it a model can spend its whole budget reading and have none left to act.
   */
  reserve?: { calls: number; tools: string[] };
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
}

export interface LoopResult<T> {
  result: T;
  toolCalls: ToolCallRecord[];
  turns: number;
  costUsd: number;
}

export class LoopFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopFailed';
  }
}

const MAX_TOOL_OUTPUT = 12_000;
const asTool = (t: { name: string; description: string; parameters: Record<string, unknown> }): ChatCompletionTool => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

/**
 * Lets the model work towards one structured answer: it may call the given tools, and it
 * finishes by calling the submit tool. Bounded: after `maxToolCalls - 1` calls the only tool
 * left is submit. A submission that fails validation is returned to the model once with the error.
 */
export async function runToolLoop<T>(opts: LoopOptions<T>): Promise<LoopResult<T>> {
  const budget = opts.reserve
    ? `You have ${opts.maxToolCalls} tool calls in total, counting the final ${opts.submit.name}. The last ${opts.reserve.calls} can only be ${opts.reserve.tools.join(' or ')} and ${opts.submit.name}, so do your reading first and leave room to act.`
    : `You have ${opts.maxToolCalls} tool calls in total, counting the final ${opts.submit.name}.`;
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: `${opts.user}\n\n${budget}` },
  ];
  const all = [...opts.tools.map(asTool), asTool(opts.submit)];
  const toolCalls: ToolCallRecord[] = [];
  let rejectedSubmissions = 0;
  let costUsd = 0;

  for (let turn = 1; turn <= opts.maxToolCalls + 2; turn++) {
    const remaining = opts.maxToolCalls - toolCalls.length;
    const mustSubmit = remaining <= 1;
    const reserved = !mustSubmit && opts.reserve !== undefined && remaining <= opts.reserve.calls;
    const allowed = reserved ? new Set(opts.reserve!.tools) : null;
    const { message, costUsd: cost } = await opts.chat(
      {
        messages,
        tools: mustSubmit ? [asTool(opts.submit)] : allowed ? [...opts.tools.filter((t) => allowed.has(t.name)).map(asTool), asTool(opts.submit)] : all,
        toolChoice: mustSubmit ? { type: 'function', function: { name: opts.submit.name } } : 'required',
      },
      opts.ctx,
    );
    costUsd += cost ?? 0;
    messages.push(message);
    const calls = (message.tool_calls ?? []).filter((c) => c.type === 'function');
    if (calls.length === 0) {
      messages.push({ role: 'user', content: `Call a tool. When you have your answer, call ${opts.submit.name}.` });
      continue;
    }

    for (const call of calls) {
      const reply = (content: string) => messages.push({ role: 'tool', tool_call_id: call.id, content });
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        toolCalls.push({ name: call.function.name, args: call.function.arguments, ok: false });
        reply('Error: the arguments were not valid JSON. Call the tool again with valid JSON.');
        continue;
      }

      if (call.function.name === opts.submit.name) {
        try {
          const result = await guarded('submission', JSON.stringify(args), () => opts.submit.parse(args));
          toolCalls.push({ name: call.function.name, args, ok: true });
          return { result, toolCalls, turns: turn, costUsd };
        } catch (err) {
          toolCalls.push({ name: call.function.name, args, ok: false });
          note('submission rejected: {reason}', { reason: (err as Error).message, level: 'warn' });
          if (++rejectedSubmissions > 1) throw new LoopFailed(`Model submitted an invalid answer twice: ${(err as Error).message}`);
          reply(`Error: the submission was rejected. ${(err as Error).message} Correct it and call ${opts.submit.name} again.`);
        }
        continue;
      }

      const tool = opts.tools.find((t) => t.name === call.function.name);
      if (!tool || mustSubmit || (allowed && !allowed.has(tool.name))) {
        toolCalls.push({ name: call.function.name, args, ok: false });
        reply(!tool ? `Error: unknown tool ${call.function.name}.` : mustSubmit ? `Error: no tool calls are left. Call ${opts.submit.name} now.` : `Error: ${tool.name} is no longer available. Only ${[...allowed!].join(', ')} and ${opts.submit.name} are left.`);
        continue;
      }
      try {
        const output = await traced(`tool.${tool.name}`, 'TOOL', { tool: tool.name }, () => tool.run(args), args);
        toolCalls.push({ name: tool.name, args, ok: true });
        const left = opts.maxToolCalls - toolCalls.length;
        const warning = left <= 6 ? `\n[${left} tool call${left === 1 ? '' : 's'} left]` : '';
        reply((output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n[truncated]` : output) + warning);
      } catch (err) {
        toolCalls.push({ name: tool.name, args, ok: false });
        reply(`Error: ${(err as Error).message}`);
      }
    }
  }
  throw new LoopFailed(`Model did not submit an answer within ${opts.maxToolCalls} tool calls`);
}

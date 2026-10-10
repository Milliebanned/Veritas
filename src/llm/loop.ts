import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { traced } from '../observability/neatlogs.ts';
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
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  const all = [...opts.tools.map(asTool), asTool(opts.submit)];
  const toolCalls: ToolCallRecord[] = [];
  let rejectedSubmissions = 0;
  let costUsd = 0;

  for (let turn = 1; turn <= opts.maxToolCalls + 2; turn++) {
    const mustSubmit = toolCalls.length >= opts.maxToolCalls - 1;
    const { message, costUsd: cost } = await opts.chat(
      {
        messages,
        tools: mustSubmit ? [asTool(opts.submit)] : all,
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
          const result = opts.submit.parse(args);
          toolCalls.push({ name: call.function.name, args, ok: true });
          return { result, toolCalls, turns: turn, costUsd };
        } catch (err) {
          toolCalls.push({ name: call.function.name, args, ok: false });
          if (++rejectedSubmissions > 1) throw new LoopFailed(`Model submitted an invalid answer twice: ${(err as Error).message}`);
          reply(`Error: the submission was rejected. ${(err as Error).message} Correct it and call ${opts.submit.name} again.`);
        }
        continue;
      }

      const tool = opts.tools.find((t) => t.name === call.function.name);
      if (!tool || mustSubmit) {
        toolCalls.push({ name: call.function.name, args, ok: false });
        reply(tool ? `Error: no tool calls are left. Call ${opts.submit.name} now.` : `Error: unknown tool ${call.function.name}.`);
        continue;
      }
      try {
        const output = await traced(`tool.${tool.name}`, 'TOOL', { tool: tool.name }, () => tool.run(args), args);
        toolCalls.push({ name: tool.name, args, ok: true });
        reply(output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n[truncated]` : output);
      } catch (err) {
        toolCalls.push({ name: tool.name, args, ok: false });
        reply(`Error: ${(err as Error).message}`);
      }
    }
  }
  throw new LoopFailed(`Model did not submit an answer within ${opts.maxToolCalls} tool calls`);
}

// The Muse Spark brain: persona + context + tool-calling loop.
import { chat, type ChatMessage } from '../meta.ts';
import { personaPrompt, contextPrompt } from './prompts.ts';
import { runTool, TOOL_DEFS, type ToolEffects } from './tools.ts';
import type { BrainInput, BrainOutput } from './types.ts';

const MAX_TOOL_ROUNDS = 4;
const HISTORY_TURNS = 16;

export async function museBrain(input: BrainInput): Promise<BrainOutput> {
  const messages: ChatMessage[] = [
    { role: 'system', content: personaPrompt(input) },
    { role: 'system', content: contextPrompt(input) },
  ];
  for (const h of input.history.slice(-HISTORY_TURNS)) {
    messages.push(h.role === 'patient' ? { role: 'user', content: h.text } : { role: 'assistant', content: h.text });
  }
  messages.push({
    role: 'user',
    content:
      input.patientText ??
      (input.event === 'media_ended'
        ? '(The song or message has just finished playing.)'
        : '(The companion is starting the conversation now. Say your opening line.)'),
  });

  const fx: ToolEffects = { actions: [], end: false, log: [] };
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await chat({
      messages,
      tools: round < MAX_TOOL_ROUNDS ? TOOL_DEFS : undefined,
      reasoning: 'low',
      maxTokens: 350,
    });
    if (!res.toolCalls.length) {
      const text = (res.content ?? '').trim();
      if (!text) throw new Error('Muse Spark returned an empty reply');
      return { text, actions: fx.actions, end: fx.end, toolLog: fx.log, source: 'muse' };
    }
    messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        // Bad arguments are reported back to the model as an error result.
      }
      const result = await runTool(call.function.name, args, input, fx).catch((e) => ({ ok: false, error: String(e) }));
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('Muse Spark did not finish within the tool budget');
}

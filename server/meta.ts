// Thin client for the Meta Model API (https://dev.meta.ai/docs).
// Chat uses the OpenAI-compatible /chat/completions surface; speech uses
// Muse Voice Transcribe's file endpoint (POST /v1/asr/transcribe, WAV only).
import { config, hasMeta } from './config.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export class MetaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

// Some deployments reject reasoning_effort; remember that and stop sending it.
let reasoningSupported = true;

async function post(path: string, body: BodyInit, headers: Record<string, string>, timeoutMs = config.meta.timeoutMs) {
  if (!hasMeta()) throw new MetaError('META_API_KEY is not set');
  const res = await fetch(`${config.meta.base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.meta.apiKey}`, ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new MetaError(`Meta API ${path} ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return res;
}

export async function chat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  jsonSchema?: { name: string; schema: object };
  timeoutMs?: number;
}): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  const body: Record<string, unknown> = {
    model: opts.model ?? config.meta.chatModel,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 400,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  if (opts.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
    };
  }
  if (opts.reasoning && reasoningSupported) body.reasoning_effort = opts.reasoning;

  let res: Response;
  try {
    res = await post('/chat/completions', JSON.stringify(body), { 'Content-Type': 'application/json' }, opts.timeoutMs);
  } catch (e) {
    if (e instanceof MetaError && e.status === 400 && 'reasoning_effort' in body) {
      reasoningSupported = false;
      delete body.reasoning_effort;
      res = await post('/chat/completions', JSON.stringify(body), { 'Content-Type': 'application/json' }, opts.timeoutMs);
    } else {
      throw e;
    }
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const msg = json.choices?.[0]?.message;
  return { content: msg?.content ?? null, toolCalls: msg?.tool_calls ?? [] };
}

/** Asks for JSON matching a schema; tolerates models that wrap JSON in prose. */
export async function chatJson<T>(opts: {
  system: string;
  user: string | ContentPart[];
  name: string;
  schema: object;
  model?: string;
  maxTokens?: number;
}): Promise<T> {
  const { content } = await chat({
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    model: opts.model,
    temperature: 0.3,
    maxTokens: opts.maxTokens ?? 1200,
    jsonSchema: { name: opts.name, schema: opts.schema },
    timeoutMs: 45000,
  });
  return parseJsonLoose<T>(content ?? '');
}

export function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as T;
    throw new MetaError('Model did not return JSON');
  }
}

/**
 * Speech to text with Muse Voice Transcribe. Names from the memory book are sent
 * as keywords so "Leo" and "Biscuit" aren't heard as "Leah" and "biscuits".
 */
export async function transcribe(wav: Uint8Array, keywords: string[] = []): Promise<string> {
  const form = new FormData();
  const request: Record<string, unknown> = {
    model: config.meta.asrModel,
    audioEncoding: 'WAV',
    mode: 'PUSH_TO_TALK',
    languageBias: ['English'],
  };
  if (keywords.length) request.keywords = keywords.slice(0, 50);
  form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
  form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
  const res = await post('/asr/transcribe', form, { Accept: 'application/json' }, 30000);
  const json = (await res.json()) as { transcript?: string; turns?: { transcript: string }[] };
  return (json.transcript ?? json.turns?.map((t) => t.transcript).join(' ') ?? '').trim();
}

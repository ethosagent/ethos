import { z } from 'zod';

// Wire schemas for `POST /v1/chat/completions` — request, non-streaming
// response, and streaming chunk. Client-tools mode (`tools`, `role: 'tool'`,
// assistant tool_calls) is accepted into the schema for forward-compat but
// the route layer rejects them until C1 lands so the failure path is loud,
// not lossy.

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const TextContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ImageUrlContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

const ContentPartSchema = z.discriminatedUnion('type', [
  TextContentPartSchema,
  ImageUrlContentPartSchema,
]);

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string(), z.array(ContentPartSchema)]).nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
});

export const ChatToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  }),
});

export const StreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
});

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(ChatMessageSchema).min(1),
    stream: z.boolean().optional(),
    stream_options: StreamOptionsSchema.optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    seed: z.number().int().optional(),
    tools: z.array(ChatToolSchema).optional(),
    user: z.string().optional(),
  })
  .passthrough(); // Unknown fields tolerated; the route stamps an
// `x-ethos-warning` if it drops anything material.

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;

// ---------------------------------------------------------------------------
// Response (non-streaming)
// ---------------------------------------------------------------------------

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length' | 'tool_calls';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Streaming chunk
// ---------------------------------------------------------------------------

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: ChatCompletionChunkDelta;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

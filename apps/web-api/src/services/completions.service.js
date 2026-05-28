import { randomUUID } from 'node:crypto';
import { EthosError } from '@ethosagent/types';
export class CompletionsService {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  async complete(input) {
    const { sessionKey, lastUserText, attachments } = await this.prepareSession(input);
    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    const finishReason = 'stop';
    for await (const event of this.driveLoop({
      sessionKey,
      lastUserText,
      personalityId: input.personalityId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.req.temperature !== undefined ? { temperature: input.req.temperature } : {}),
      ...(input.req.top_p !== undefined ? { topP: input.req.top_p } : {}),
      ...(input.req.max_tokens !== undefined ? { maxCompletionTokens: input.req.max_tokens } : {}),
      ...(input.req.seed !== undefined ? { seed: input.req.seed } : {}),
      ...(attachments?.length ? { attachments } : {}),
    })) {
      if (event.type === 'text_delta') text += event.text;
      else if (event.type === 'usage') {
        promptTokens += event.inputTokens;
        completionTokens += event.outputTokens;
      } else if (event.type === 'error') {
        throw new EthosError({
          code: 'INTERNAL',
          cause: event.error,
          action: 'Retry the request. If the error repeats, file an issue.',
        });
      }
    }
    return {
      id: `chatcmpl-${this.id()}`,
      object: 'chat.completion',
      created: this.unixNow(),
      model: input.req.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
  async *stream(input) {
    const { sessionKey, lastUserText, attachments } = await this.prepareSession(input);
    const id = `chatcmpl-${this.id()}`;
    const created = this.unixNow();
    const model = input.req.model;
    let promptTokens = 0;
    let completionTokens = 0;
    let yieldedRole = false;
    for await (const event of this.driveLoop({
      sessionKey,
      lastUserText,
      personalityId: input.personalityId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.req.temperature !== undefined ? { temperature: input.req.temperature } : {}),
      ...(input.req.top_p !== undefined ? { topP: input.req.top_p } : {}),
      ...(input.req.max_tokens !== undefined ? { maxCompletionTokens: input.req.max_tokens } : {}),
      ...(input.req.seed !== undefined ? { seed: input.req.seed } : {}),
      ...(attachments?.length ? { attachments } : {}),
    })) {
      if (event.type === 'text_delta') {
        const delta = yieldedRole
          ? { content: event.text }
          : { role: 'assistant', content: event.text };
        yieldedRole = true;
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
      } else if (event.type === 'usage') {
        promptTokens += event.inputTokens;
        completionTokens += event.outputTokens;
      } else if (event.type === 'error') {
        throw new EthosError({
          code: 'INTERNAL',
          cause: event.error,
          action: 'Retry the request. If the error repeats, file an issue.',
        });
      }
    }
    // Final chunk — empty delta + finish_reason terminator. OpenAI clients
    // gate on this.
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    // Optional usage chunk — only when the client opted in. OpenAI's docs
    // show it as the absolute last data frame, with `choices: []`.
    if (input.req.stream_options?.include_usage) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    }
  }
  // ---------------------------------------------------------------------------
  // Session preparation
  // ---------------------------------------------------------------------------
  async prepareSession(input) {
    const lastUser = finalUserMessage(input.req.messages);
    if (!lastUser) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'messages must end with a `user` message.',
        action: 'Place the user prompt last in the messages array.',
      });
    }
    const attachments = lastUser.attachments;
    // Stateful mode — opt-in via `X-Ethos-Session`. Server-side history wins;
    // we only feed in the latest user text. Prior messages from the request
    // are ignored. (Per-message verification is a future enhancement.)
    if (input.sessionKeyOverride) {
      return {
        sessionKey: `openai:${input.sessionKeyOverride}`,
        lastUserText: lastUser.text,
        ...(attachments?.length ? { attachments } : {}),
      };
    }
    // Stateless mode — fresh ephemeral session, pre-populated with the
    // prior user/assistant turns so the LLM sees the full conversation.
    const sessionKey = `openai:ephem:${randomUUID()}`;
    const prior = priorTextMessages(input.req.messages, lastUser.index);
    if (prior.length === 0) {
      // No history to inject — AgentLoop will create the session lazily
      // on its first `getSessionByKey ?? createSession`.
      return {
        sessionKey,
        lastUserText: lastUser.text,
        ...(attachments?.length ? { attachments } : {}),
      };
    }
    const created = await this.opts.sessions.createSession({
      key: sessionKey,
      platform: 'openai',
      model: this.opts.defaults.model,
      provider: this.opts.defaults.provider,
      usage: zeroUsage(),
    });
    for (const msg of prior) {
      await this.opts.sessions.appendMessage({
        sessionId: created.id,
        role: msg.role,
        content: msg.text,
      });
    }
    return {
      sessionKey,
      lastUserText: lastUser.text,
      ...(attachments?.length ? { attachments } : {}),
    };
  }
  driveLoop(input) {
    const opts = {
      sessionKey: input.sessionKey,
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.maxCompletionTokens !== undefined
        ? { maxCompletionTokens: input.maxCompletionTokens }
        : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
    return this.opts.loop.run(input.lastUserText, opts);
  }
  id() {
    return this.opts.newId ? this.opts.newId() : randomUUID();
  }
  unixNow() {
    return Math.floor((this.opts.now ? this.opts.now() : new Date()).getTime() / 1000);
  }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * The OpenAI contract is that the final message in `messages[]` is the new
 * turn the model is being asked to respond to. F3 only handles server-tools
 * mode, so the trailing message must be `user` with string content; trailing
 * `assistant` / `tool` lands in C1. Anything else is malformed — silently
 * rerunning an earlier user prompt would corrupt conversation semantics.
 *
 * Handles both plain string and array (multimodal) content. When the content
 * is an array, text parts are joined and image_url parts are translated into
 * Attachment refs so they can flow through the AgentLoop attachment pipeline.
 */
function finalUserMessage(messages) {
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || last.role !== 'user') return null;
  if (typeof last.content === 'string') {
    if (last.content.length === 0) return null;
    return { index: lastIndex, text: last.content };
  }
  if (Array.isArray(last.content)) {
    const textParts = last.content.filter((p) => p.type === 'text').map((p) => p.text);
    const text = textParts.join('\n');
    if (text.length === 0) return null;
    const imageParts = last.content.filter((p) => p.type === 'image_url');
    const attachments = imageParts.map((p) => ({
      type: 'image',
      ref: p.image_url.url,
      url: p.image_url.url,
      mimeType: 'image/png', // default; actual type determined at fetch time
    }));
    return { index: lastIndex, text, ...(attachments.length ? { attachments } : {}) };
  }
  return null;
}
function priorTextMessages(messages, lastUserIndex) {
  const out = [];
  for (let i = 0; i < lastUserIndex; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue; // skip system / tool
    const text = extractText(msg.content);
    if (text === null) continue;
    out.push({ role: msg.role, text });
  }
  return out;
}
function extractText(content) {
  if (typeof content === 'string') return content.length === 0 ? null : content;
  if (Array.isArray(content)) {
    const text = content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return text.length === 0 ? null : text;
  }
  return null;
}
function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  };
}

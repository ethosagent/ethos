import type { AgentEvent, Attachment, MemoryContext, PromptContext } from '@ethosagent/types';
import { buildAttachmentAnnotation } from '../../attachment-annotation';
import { classifyAttachment, unsupportedTypeError } from '../../attachment-classifier';
import { formatInlinedAttachment, resolveTextAttachment } from '../../attachment-text-resolver';
import { maybeCompact } from '../compaction';
import { dedupHistory, toLLMMessages } from '../history';
import type { AssembledContext, LoopDeps, TurnSetup } from '../turn-context';

/**
 * Context-assembly stage: PII redaction, user message persistence, history
 * load, memory prefetch + sanitize, system prompt build (injectors, memory,
 * hooks, dry-run), context_meta event, history-to-LLM messages, compaction.
 *
 * Yields AgentEvent while running; returns AssembledContext.
 */
export async function* assembleContext(
  deps: LoopDeps,
  setup: TurnSetup,
  text: string,
  opts: {
    attachments?: Attachment[];
    userId?: string;
    dryRun?: boolean;
  },
): AsyncGenerator<AgentEvent, AssembledContext> {
  const {
    sessionId,
    sessionKey,
    personality,
    turnNumber,
    lastCompactionTurn,
    allowedPlugins,
    memScopeId,
  } = setup;

  // Step 3: Persist the user message.
  //
  // Subagent task contract: the delegated task always lives in the child's
  // first user message (this `text`). It is NEVER copied into the system
  // prompt, NEVER injected via memory, and NEVER duplicated across both.
  // The regression test in
  // `extensions/tools-delegation/src/__tests__/task-contract.test.ts`
  // captures every `LLMProvider.complete()` request and asserts the marker
  // never appears in `opts.system` and appears exactly once across all
  // user-role messages.
  //
  // Attachment annotation: prepend an <attachments> block so the LLM sees
  // which files/images the user attached. Persisted with the message so
  // replay is faithful (plan risk #10).
  const piiConfig = personality.safety?.piiRedaction;

  // Classify and resolve text attachments
  const rawAttachments = opts.attachments ?? [];
  const inlineBlocks: string[] = [];
  const annotatedAttachments: Attachment[] = [];
  const attachmentErrors: string[] = [];

  for (const att of rawAttachments) {
    const cls = classifyAttachment(att);
    switch (cls) {
      case 'native':
        // Class A -- keep for annotation, existing vision path handles these
        annotatedAttachments.push(att);
        break;
      case 'text': {
        // Class B-text -- read, decode, inline
        try {
          const resolved = await resolveTextAttachment(att, deps.storage, deps.attachmentCache);
          // S6 -- inbound injection scan on inlined text
          const sanitized = deps.safety.injection.sanitize(resolved.text);
          const formatted = formatInlinedAttachment({
            ...resolved,
            text: sanitized,
          });
          inlineBlocks.push(formatted);
        } catch {
          attachmentErrors.push(
            `Failed to read "${att.filename ?? att.mimeType}": file could not be decoded as text`,
          );
        }
        break;
      }
      case 'extract':
        // Class B-extract -- stub for PR2, annotate so LLM knows it's there
        annotatedAttachments.push(att);
        break;
      case 'unsupported':
        attachmentErrors.push(unsupportedTypeError(att.mimeType, att.filename));
        break;
    }
  }

  // Build annotation only for Class A + Class B-extract attachments
  const attachmentAnnotation = buildAttachmentAnnotation(annotatedAttachments);

  // Build inline prefix: errors first (so user sees them), then inlined file content
  // Aggregate inline budget — cap total inlined text to prevent prompt explosion
  const INLINE_BUDGET_CHARS = 100_000;
  let totalInlinedChars = 0;
  const budgetedBlocks: string[] = [];
  for (const block of inlineBlocks) {
    totalInlinedChars += block.length;
    if (totalInlinedChars > INLINE_BUDGET_CHARS) {
      const remaining = inlineBlocks.length - budgetedBlocks.length;
      budgetedBlocks.push(`[${remaining} more file(s) omitted — inline budget exceeded]`);
      break;
    }
    budgetedBlocks.push(block);
  }

  const inlinePrefix = [...attachmentErrors, ...budgetedBlocks].join('\n\n');

  const fullPrefix = [attachmentAnnotation, inlinePrefix].filter(Boolean).join('\n\n');
  const rawAnnotatedText = fullPrefix ? `${fullPrefix}\n\n${text}` : text;
  const annotatedText = piiConfig?.enabled
    ? deps.safety.redaction.redactPii(rawAnnotatedText, piiConfig.extraPatterns)
    : rawAnnotatedText;

  await deps.session.appendMessage({
    sessionId,
    role: 'user',
    content: annotatedText,
  });

  // Step 4: Load history (trimmed to most-recent limit)
  const allMessages = await deps.session.getMessages(sessionId, { limit: deps.historyLimit });
  const history = allMessages.filter((m) => m.role !== 'system');

  // Step 5: Prefetch memory.
  //
  // Per-personality memory backend: if the personality declares a `memory.provider`,
  // resolve it from the registry. Otherwise fall back to the global provider.
  const activeMemory = personality.memory?.provider
    ? ((await deps.memoryProviders.get(personality.memory.provider)?.(
        personality.memory.options,
      )) ?? deps.memory)
    : deps.memory;

  const memCtx: MemoryContext = {
    scopeId: memScopeId,
    sessionId,
    sessionKey,
    platform: deps.platform,
    workingDir: deps.workingDir,
  };
  let memSnapshot = await activeMemory.prefetch(memCtx);

  // Providers that don't support bulk prefetch (e.g. VectorMemoryProvider)
  // return null. Fall back to a semantic search on the current user text so
  // those backends still inject relevant context into the system prompt —
  // restoring the query-driven retrieval the old two-method contract did
  // internally inside prefetch().
  if (!memSnapshot && text.trim()) {
    const hits = await activeMemory.search(text, memCtx, { limit: 5 });
    if (hits.length > 0) {
      memSnapshot = { entries: hits.map((h) => ({ key: h.key, content: h.content })) };
    }
  }

  // Per-user profile prefetch
  const userScopeId = opts.userId ? `user:${opts.userId}` : undefined;
  if (userScopeId) {
    const userCtx: MemoryContext = {
      scopeId: userScopeId,
      sessionId,
      sessionKey,
      platform: deps.platform,
      workingDir: deps.workingDir,
    };
    const userEntry = await activeMemory.read('USER.md', userCtx);
    if (userEntry?.content.trim()) {
      const userSnapshot = {
        entries: [{ key: 'USER.md', content: userEntry.content }],
      };
      if (memSnapshot) {
        memSnapshot = { entries: [...userSnapshot.entries, ...memSnapshot.entries] };
      } else {
        memSnapshot = userSnapshot;
      }
    }
  }

  // Backstop: sanitize memory content for prompt-injection patterns before
  // injecting into the system prompt (same defense context files get).
  if (memSnapshot) {
    memSnapshot = {
      entries: memSnapshot.entries.map((e) => ({
        key: e.key,
        content: deps.safety.injection.sanitize(e.content),
      })),
    };
  }

  // Step 6: Build system prompt from injectors
  const promptCtx: PromptContext = {
    sessionId,
    sessionKey,
    platform: deps.platform,
    model: deps.llm.model,
    history,
    workingDir: deps.workingDir,
    isDm: true,
    turnNumber: allMessages.length,
    personalityId: personality.id,
  };

  const systemParts: string[] = [];

  // Ch.3a — prepend the injection-defense prelude so the model knows how to
  // read `<untrusted>` blocks before any personality content sets the tone.
  const injectionDefenseEnabled = personality.safety?.injectionDefense?.enabled !== false;
  if (injectionDefenseEnabled) {
    systemParts.push(deps.safety.injection.prelude);
  }

  // SOUL.md / personality identity — routes through Storage so ScopedStorage
  // and InMemoryStorage fixtures work correctly. Only runs when storage is
  // wired (production always provides it; tests without a real soulFile skip).
  if (personality.soulFile && deps.storage) {
    const identity = await deps.storage.read(personality.soulFile);
    if (identity) systemParts.push(identity.trim());
  }

  // Context injectors sorted by priority (already sorted in constructor)
  for (const injector of deps.injectors) {
    // Plugin-registered injectors only fire when the plugin is permitted.
    const injPluginId = deps.injectorPluginIds.get(injector);
    if (injPluginId !== undefined && !allowedPlugins.includes(injPluginId)) continue;
    if (injector.shouldInject && !injector.shouldInject(promptCtx)) continue;
    const result = await injector.inject(promptCtx);
    if (result) {
      if (result.position === 'prepend') {
        systemParts.unshift(result.content);
      } else {
        systemParts.push(result.content);
      }
    }
  }

  // Emit injector metadata (e.g. skill_files_used) so eval harness can capture it.
  if (promptCtx.meta && Object.keys(promptCtx.meta).length > 0) {
    yield { type: 'context_meta', data: promptCtx.meta };
  }
  const rawSkills = promptCtx.meta?.skillFilesUsed;
  const activeSkillFiles =
    Array.isArray(rawSkills) && rawSkills.every((s) => typeof s === 'string')
      ? (rawSkills as string[])
      : undefined;

  // Memory injected last, as context about the user. The snapshot is a
  // list of (key, content) pairs; render USER.md as "About You" first,
  // MEMORY.md as "Memory" second, anything else as its own section.
  //
  // Hard cap on the total memory block at 20k chars — same budget the
  // old MarkdownFileMemoryProvider enforced internally. Without this,
  // a long-running session's MEMORY.md grows unbounded and silently
  // explodes the system prompt token bill.
  if (memSnapshot && memSnapshot.entries.length > 0) {
    const blocks: string[] = [];
    const orderHints: Record<string, string> = {
      'USER.md': 'About You',
      'MEMORY.md': 'Memory',
    };
    const sorted = [...memSnapshot.entries].sort((a, b) => {
      const rank = (k: string) => (k === 'USER.md' ? 0 : k === 'MEMORY.md' ? 1 : 2);
      return rank(a.key) - rank(b.key);
    });
    for (const e of sorted) {
      const heading = orderHints[e.key] ?? e.key;
      const redact = deps.safety.redaction.redactString;
      blocks.push(`## ${heading}\n\n${redact(e.content.trim())}`);
    }
    if (blocks.length > 0) {
      let rendered = `## Memory\n\n${blocks.join('\n\n')}`;
      const MEMORY_MAX_CHARS = 20_000;
      if (rendered.length > MEMORY_MAX_CHARS) {
        // Tail-keep — newer memory lives at the end; the prelude carries
        // less per-token signal than the freshest facts.
        rendered = `[...truncated]\n\n${rendered.slice(-MEMORY_MAX_CHARS)}`;
      }
      systemParts.push(rendered);
    }
  }

  // Step 7: Before-prompt-build modifying hooks (plugins can prepend/append/override)
  const buildResult = await deps.hooks.fireModifying(
    'before_prompt_build',
    {
      sessionId,
      personalityId: personality.id,
      history,
    },
    allowedPlugins,
  );

  if (buildResult.overrideSystem) {
    systemParts.length = 0;
    systemParts.push(buildResult.overrideSystem);
  } else {
    if (buildResult.prependSystem) systemParts.unshift(buildResult.prependSystem);
    if (buildResult.appendSystem) systemParts.push(buildResult.appendSystem);
  }

  if (opts.dryRun) {
    systemParts.push(
      'IMPORTANT: You are in DRY-RUN mode. Every tool call will be intercepted and return a stub ' +
        'result — no tool actually executes. Plan your tool calls as normal but do NOT retry or ' +
        'loop when you see "[dry-run]" in the result. After your first batch of tool calls, ' +
        'summarize what you would have done and stop.',
    );
  }

  const systemPrompt = systemParts.join('\n\n').trim() || undefined;

  // Step 8: Agentic loop — LLM call → tool use → LLM call → ...
  // Q1 — collapse exact-duplicate tool results before building the
  // LLM-facing history, so re-reads of the same file don't burn tokens.
  let llmMessages = toLLMMessages(dedupHistory(history));
  // E4 — pre-LLM compaction. If estimated context usage already exceeds
  // the personality's pressure threshold (80% of the model's window by
  // default), the resolved context engine compacts before we hand the
  // history to the provider.
  const compacted = await maybeCompact(
    {
      llm: deps.llm,
      contextEngines: deps.contextEngines,
      session: deps.session,
      observability: deps.observability,
      llmHandle: deps.llmHandle,
      storage: deps.storage,
      dataDir: deps.dataDir,
      countTokens: deps.llm.countTokens.bind(deps.llm),
    },
    llmMessages,
    systemPrompt ?? '',
    personality,
    {
      sessionId,
      sessionKey,
      turnNumber,
      lastCompactionTurn,
    },
  );
  llmMessages = compacted.messages;
  // F2 — cache breakpoints from the compaction, forwarded to every provider
  // call this turn so the prompt cache survives the compacted prefix.
  const cacheBreakpoints = compacted.cacheBreakpoints;
  // V1 — surface a one-line in-chat compaction notice. Emitted once, before
  // any response text, via the `tool_progress` + `audience: 'user'` channel
  // the framework already uses for `_budget` / `_watcher` notices.
  if (compacted.notice) {
    const n = compacted.notice;
    const tok = n.summaryTokens > 0 ? `, ${n.summaryTokens} tok` : '';
    yield {
      type: 'tool_progress',
      toolName: '_compaction',
      message: `compressed ${n.droppedCount} earlier message(s) (${n.engineName}${tok})`,
      audience: 'user',
    };
  }

  return {
    systemPrompt,
    llmMessages,
    cacheBreakpoints,
    activeSkillFiles,
    injectionDefenseEnabled,
    baseMessageCount: allMessages.length,
    userScopeId,
  };
}

// E3 — Auto-triggered skill evolution. Subscribes to `agent_done`, applies
// per-personality thresholds + cooldown, and writes a placeholder candidate
// to the per-personality pending dir for human review via `ethos evolve
// --list-pending` / `--accept` / `--reject`.
//
// This is a deliberately lightweight stub generator. It writes a skeleton
// SKILL.md so the candidate appears in the queue with full provenance
// (source session, turn count, tool sequence). The richer "summarize the
// workflow into a polished SKILL.md body" step still belongs to the manual
// `ethos evolve --eval-output` flow — auto-trigger only ensures candidates
// reach the queue.
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
/** Maps personalityId → cooldown state. Cleared on process restart. */
const cooldowns = new Map();
/**
 * Wires the auto-trigger as an `agent_done` hook subscriber. Returns the
 * cleanup function from `registerVoid` so callers can detach in tests.
 */
export function registerSkillEvolutionAutoTrigger(opts) {
    const storage = opts.storage ?? new FsStorage();
    const now = opts.now ?? (() => Date.now());
    return opts.hooks.registerVoid('agent_done', async (payload) => {
        if (!payload.personalityId)
            return;
        const personality = opts.personalities.get(payload.personalityId);
        if (!personality)
            return;
        const cfg = personality.skill_evolution;
        if (!cfg?.enabled)
            return;
        const minToolCalls = cfg.min_tool_calls ?? 5;
        const cooldownMinutes = cfg.cooldown_minutes ?? 60;
        const successfulCalls = payload.successfulToolCalls ?? 0;
        if (successfulCalls < minToolCalls)
            return;
        // Cooldown — refuse to re-queue too quickly per personality.
        const state = cooldowns.get(personality.id);
        const nowMs = now();
        if (state && nowMs - state.lastFiredAtMs < cooldownMinutes * 60_000)
            return;
        cooldowns.set(personality.id, { lastFiredAtMs: nowMs });
        const pendingDir = join(opts.dataDir, 'skills', '.pending', personality.id);
        await storage.mkdir(pendingDir);
        const id = `auto-${nowMs}-${randomSuffix()}`;
        const filename = `${id}.md`;
        const candidate = renderCandidate({
            id,
            personalityId: personality.id,
            sessionId: payload.sessionId,
            turnCount: payload.turnCount,
            successfulToolCalls: successfulCalls,
            totalToolCalls: payload.totalToolCalls ?? successfulCalls,
            toolNames: payload.toolNames ?? [],
            initialPrompt: payload.initialPrompt ?? '',
            finalText: payload.text,
        });
        await storage.write(join(pendingDir, filename), candidate);
    });
}
/** Reset cooldowns (test-only helper). */
export function resetSkillEvolutionCooldowns() {
    cooldowns.clear();
}
function renderCandidate(input) {
    const tools = input.toolNames.length > 0 ? input.toolNames.join(', ') : '(none recorded)';
    const trimmedPrompt = truncate(input.initialPrompt, 400);
    const trimmedFinal = truncate(input.finalText, 400);
    return `---
name: ${input.id}
description: Auto-proposed skill candidate from ${input.personalityId}
ethos:
  evolution:
    auto_proposed: true
    source_session: "${input.sessionId}"
    source_turn: ${input.turnCount}
    source_personality: ${input.personalityId}
---
# Auto-proposed skill candidate

This skill was queued by the auto-trigger after a successful workflow on
the **${input.personalityId}** personality. It needs human review and
rewriting before it can be promoted via \`ethos evolve --accept ${input.id}\`.

## Trigger metadata
- Successful tool calls: ${input.successfulToolCalls} (of ${input.totalToolCalls})
- Tools used: ${tools}
- Turn count: ${input.turnCount}

## Initial prompt
${trimmedPrompt}

## Final response
${trimmedFinal}
`;
}
function truncate(s, n) {
    if (s.length <= n)
        return s;
    return `${s.slice(0, n)}…`;
}
function randomSuffix() {
    return Math.random().toString(36).slice(2, 8);
}

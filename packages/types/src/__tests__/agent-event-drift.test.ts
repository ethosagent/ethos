import { describe, expect, it } from 'vitest';
import { KNOWN_AGENT_EVENT_TYPES } from '../agent-event';

describe('AgentEvent drift gate', () => {
  // Changing this list requires two maintainers + consumer audit per ARCHITECTURE.md §VII.
  it('has exactly the frozen set of 16 event types', () => {
    const expected = [
      'text_delta',
      'thinking_delta',
      'tool_start',
      'tool_progress',
      'tool_end',
      'usage',
      'error',
      'done',
      'context_meta',
      'run_start',
      'dry_run_summary',
      'tool_approval_required',
      'tool_approval_response',
      'evaluators_complete',
      'credential_required',
      'notification_received',
    ];
    expect([...KNOWN_AGENT_EVENT_TYPES]).toEqual(expected);
    expect(KNOWN_AGENT_EVENT_TYPES).toHaveLength(16);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { type CompactResult, notifyCompactResult } from '../notify-compact-result';

function fakes() {
  return { info: vi.fn(), success: vi.fn() };
}

const ok: CompactResult = {
  ok: true,
  engineName: 'semantic_summary',
  droppedCount: 3,
  preTotalTokens: 10000,
  postTotalTokens: 4000,
  summariesEnabled: true,
};

describe('notifyCompactResult', () => {
  it('says there is not enough history for null', () => {
    const n = fakes();
    notifyCompactResult(n, null);
    expect(n.info).toHaveBeenCalledWith({
      message: 'Compaction',
      description: 'Not enough history to compact yet.',
    });
    expect(n.success).not.toHaveBeenCalled();
  });

  it('says there is not enough history for ok:false', () => {
    const n = fakes();
    notifyCompactResult(n, { ...ok, ok: false });
    expect(n.info).toHaveBeenCalledTimes(1);
    expect(n.success).not.toHaveBeenCalled();
  });

  it('reports the saving on success', () => {
    const n = fakes();
    notifyCompactResult(n, ok);
    expect(n.success).toHaveBeenCalledWith({
      message: 'Compacted 3 earlier message(s)',
      description: `semantic_summary: ${(10000).toLocaleString()} → ${(4000).toLocaleString()} tok (−${(6000).toLocaleString()})`,
    });
  });

  it('appends the summaries-disabled suffix', () => {
    const n = fakes();
    notifyCompactResult(n, { ...ok, summariesEnabled: false });
    const arg = n.success.mock.calls[0]?.[0];
    expect(arg.description).toMatch(
      /\. Summaries disabled — set auxiliary\.compression\.model to enable\.$/,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { kanbanListReducer } from './kanban-list';

const ctx = { args: {}, turnCount: 0 };
function makeTickets(count, status = 'todo') {
  return Array.from({ length: count }, (_, i) => ({
    id: `TASK-${i + 1}`,
    title: `Task ${i + 1}`,
    status,
    updatedAt: new Date(Date.now() - i * 1000).toISOString(),
  }));
}
describe('kanbanListReducer', () => {
  it('≤10 tickets → passes through unchanged', () => {
    const tickets = makeTickets(10);
    const result = { ok: true, value: JSON.stringify(tickets) };
    const reduced = kanbanListReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
  it('exactly 10 tickets → passes through unchanged', () => {
    const tickets = makeTickets(10);
    const result = { ok: true, value: JSON.stringify(tickets) };
    const reduced = kanbanListReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
  it('>10 tickets → summary with status counts and top 5 open', () => {
    const todoTickets = makeTickets(8, 'todo');
    const doneTickets = makeTickets(5, 'done');
    const tickets = [...todoTickets, ...doneTickets];
    expect(tickets.length).toBe(13);
    const result = { ok: true, value: JSON.stringify(tickets) };
    const reduced = kanbanListReducer.reduce(result, ctx);
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('Counts by status:');
      expect(reduced.value).toContain('todo=8');
      expect(reduced.value).toContain('done=5');
      expect(reduced.value).toContain('Top 5 open:');
      // Should list top 5 open (todo) tickets
      expect(reduced.value).toContain('TASK-1');
    }
  });
  it('non-JSON result → passes through unchanged', () => {
    const result = { ok: true, value: 'not json at all' };
    const reduced = kanbanListReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
  it('non-array JSON result → passes through unchanged', () => {
    const result = { ok: true, value: JSON.stringify({ foo: 'bar' }) };
    const reduced = kanbanListReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
  it('error result → passes through unchanged', () => {
    const result = { ok: false, error: 'store error', code: 'execution_failed' };
    const reduced = kanbanListReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
  it('11 tickets all done → top 0 open listed', () => {
    const tickets = makeTickets(11, 'done');
    const result = { ok: true, value: JSON.stringify(tickets) };
    const reduced = kanbanListReducer.reduce(result, ctx);
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('done=11');
      expect(reduced.value).toContain('Top 0 open:');
    }
  });
});

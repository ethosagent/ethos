// Pure-builder tests for the Discord clarify components.
import { describe, expect, it } from 'vitest';
import {
  CLARIFY_ANSWER_KIND,
  CLARIFY_BUTTON_PREFIX,
  CLARIFY_CANCEL_KIND,
  CLARIFY_CHOICE_KIND,
  CLARIFY_MODAL_KIND,
  clarifyModalPayload,
  clarifyPendingMessage,
  clarifyResolvedMessage,
  escapeMd,
} from '../clarify-blocks';

const DEADLINE = '2026-05-15T00:15:00.000Z';
describe('clarifyPendingMessage', () => {
  it('renders option buttons + a Cancel row with custom_ids encoded as `clr:choice:<requestId>:<idx>`', () => {
    const msg = clarifyPendingMessage({
      requestId: 'r1',
      question: 'Pick one',
      options: ['a', 'b', 'c'],
      defaultDeadlineAt: DEADLINE,
    });
    // Three options on one row + a cancel row.
    expect(msg.components).toHaveLength(2);
    const optionRow = msg.components[0];
    expect(optionRow?.components.map((c) => c.label)).toEqual(['a', 'b', 'c']);
    expect(optionRow?.components.map((c) => c.custom_id)).toEqual([
      `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1:0`,
      `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1:1`,
      `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1:2`,
    ]);
    const cancelRow = msg.components[1];
    expect(cancelRow?.components[0]?.custom_id).toBe(
      `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CANCEL_KIND}:r1`,
    );
  });
  it('renders Answer + Cancel for free-form (no options)', () => {
    const msg = clarifyPendingMessage({
      requestId: 'r2',
      question: 'Describe',
      defaultDeadlineAt: DEADLINE,
    });
    expect(msg.components).toHaveLength(1);
    const labels = msg.components[0]?.components.map((c) => c.label);
    expect(labels).toEqual(['Answer', 'Cancel']);
    expect(msg.components[0]?.components[0]?.custom_id).toBe(
      `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_ANSWER_KIND}:r2`,
    );
  });
  it('breaks options into rows of 5 (Discord per-row cap) and caps total options at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => `opt-${i}`);
    const msg = clarifyPendingMessage({
      requestId: 'r3',
      question: 'pick',
      options: many,
      defaultDeadlineAt: DEADLINE,
    });
    const optionRows = msg.components.slice(0, -1);
    expect(optionRows).toHaveLength(4); // 20 options / 5 per row
    for (const row of optionRows) {
      expect(row?.components.length).toBeLessThanOrEqual(5);
    }
    // Cancel row is last
    expect(msg.components[msg.components.length - 1]?.components[0]?.label).toBe('Cancel');
  });
  it('escapes Discord markdown chars in the question and labels', () => {
    const msg = clarifyPendingMessage({
      requestId: 'r4',
      question: '*bold* _italic_ `code`',
      options: ['a*b', 'c_d'],
      defaultDeadlineAt: DEADLINE,
    });
    expect(msg.content).toContain('\\*bold\\*');
    expect(msg.content).toContain('\\_italic\\_');
    expect(msg.components[0]?.components[0]?.label).toBe('a\\*b');
    expect(msg.components[0]?.components[1]?.label).toBe('c\\_d');
  });
});
describe('clarifyResolvedMessage', () => {
  it('renders user-source with the answer and an answeredBy mention when id is a snowflake', () => {
    const msg = clarifyResolvedMessage({
      question: 'Q?',
      answer: 'postgres',
      source: 'user',
      answeredBy: '123456789012345678',
    });
    expect(msg.content).toContain('postgres');
    expect(msg.content).toContain('<@123456789012345678>');
    expect(msg.components).toHaveLength(0);
  });
  it('refuses to render a non-snowflake user id as a live mention', () => {
    const msg = clarifyResolvedMessage({
      question: 'Q?',
      answer: 'a',
      source: 'user',
      answeredBy: 'not-a-snowflake',
    });
    expect(msg.content).not.toContain('<@');
  });
  it('renders timeout-default with the default value', () => {
    const msg = clarifyResolvedMessage({
      question: 'Q?',
      answer: 'postgres',
      source: 'timeout-default',
    });
    expect(msg.content).toMatch(/timed out.*postgres/);
  });
  it('renders cancel without any answer', () => {
    const msg = clarifyResolvedMessage({ question: 'Q?', answer: '', source: 'cancel' });
    expect(msg.content).toMatch(/cancelled/);
  });
});
describe('clarifyModalPayload', () => {
  it('encodes requestId in custom_id and uses the contracted input id', () => {
    const m = clarifyModalPayload({ requestId: 'r9', question: 'free-form?' });
    expect(m.custom_id).toBe(`${CLARIFY_BUTTON_PREFIX}:${CLARIFY_MODAL_KIND}:r9`);
    expect(m.components[0]?.components[0]?.custom_id).toBe('clr:answer-input');
  });
});
describe('escapeMd', () => {
  it('escapes the markdown delimiters Discord cares about', () => {
    expect(escapeMd('*x_y~z|w`a\\b>c')).toBe('\\*x\\_y\\~z\\|w\\`a\\\\b\\>c');
  });
});

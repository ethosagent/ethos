// Pure-builder tests for the clarify Block Kit blocks.
import { describe, expect, it } from 'vitest';
import { CLARIFY_ANSWER_ACTION_ID, CLARIFY_CANCEL_ACTION_ID, CLARIFY_CHOICE_ACTION_ID, CLARIFY_MODAL_CALLBACK_ID, CLARIFY_MODAL_INPUT_ACTION_ID, CLARIFY_MODAL_INPUT_BLOCK_ID, clarifyModalView, clarifyPendingBlocks, clarifyResolvedBlocks, } from '../blocks/clarify';
const DEADLINE = '2026-05-15T00:15:00.000Z';
describe('clarifyPendingBlocks', () => {
    it('renders one button per option plus a Cancel button', () => {
        const blocks = clarifyPendingBlocks({
            requestId: 'r1',
            question: 'Which database?',
            options: ['postgres', 'sqlite', 'mysql'],
            default: 'postgres',
            defaultDeadlineAt: DEADLINE,
        });
        const actions = blocks.find((b) => b.type === 'actions');
        expect(actions).toBeDefined();
        const labels = actions?.elements.map((e) => e.text.text);
        expect(labels).toEqual(['postgres', 'sqlite', 'mysql', 'Cancel']);
        // Choice button values are `<requestId>:<idx>`; cancel is just <requestId>.
        expect(actions?.elements[0]?.value).toBe('r1:0');
        expect(actions?.elements[1]?.value).toBe('r1:1');
        expect(actions?.elements[2]?.value).toBe('r1:2');
        expect(actions?.elements[3]?.action_id).toBe(CLARIFY_CANCEL_ACTION_ID);
        expect(actions?.elements[3]?.value).toBe('r1');
    });
    it('renders Answer + Cancel for free-form (no options)', () => {
        const blocks = clarifyPendingBlocks({
            requestId: 'r2',
            question: 'Describe the schema',
            defaultDeadlineAt: DEADLINE,
        });
        const actions = blocks.find((b) => b.type === 'actions');
        expect(actions?.elements.map((e) => e.action_id)).toEqual([
            CLARIFY_ANSWER_ACTION_ID,
            CLARIFY_CANCEL_ACTION_ID,
        ]);
    });
    it('escapes mrkdwn special chars in the question', () => {
        const blocks = clarifyPendingBlocks({
            requestId: 'r3',
            question: '<@U999> what about <http://x|click here>?',
            defaultDeadlineAt: DEADLINE,
        });
        const sectionTexts = blocks
            .filter((b) => b.type === 'section')
            .map((b) => b.text.text);
        // escaped `<` / `>` so live mentions / links can't be injected
        expect(sectionTexts.some((t) => t.includes('&lt;@U999&gt;'))).toBe(true);
        expect(sectionTexts.some((t) => t.includes('&lt;http://x|click here&gt;'))).toBe(true);
    });
    it('caps options at 24 to leave room for Cancel within Slack action limits', () => {
        const many = Array.from({ length: 30 }, (_, i) => `opt-${i}`);
        const blocks = clarifyPendingBlocks({
            requestId: 'r4',
            question: 'pick one',
            options: many,
            defaultDeadlineAt: DEADLINE,
        });
        const actions = blocks.find((b) => b.type === 'actions');
        expect(actions?.elements.length).toBe(25); // 24 options + 1 cancel
    });
});
describe('clarifyResolvedBlocks', () => {
    it('renders a user-answered card with the answerer mention', () => {
        const blocks = clarifyResolvedBlocks({
            question: 'Which db?',
            answer: 'postgres',
            source: 'user',
            answeredBy: 'U12345',
        });
        const sections = blocks
            .filter((b) => b.type === 'section')
            .map((b) => b.text.text);
        expect(sections[0]).toContain('Question:');
        expect(sections[1]).toContain('postgres');
        const ctx = blocks.find((b) => b.type === 'context');
        expect(ctx?.elements[0]?.text).toContain('<@U12345>');
    });
    it('renders timeout-default with the default value', () => {
        const blocks = clarifyResolvedBlocks({
            question: 'Q?',
            answer: 'postgres',
            source: 'timeout-default',
        });
        const last = blocks[blocks.length - 1];
        expect(last.text.text).toMatch(/timed out.*postgres/);
    });
    it('renders cancel without an answer', () => {
        const blocks = clarifyResolvedBlocks({ question: 'Q?', answer: '', source: 'cancel' });
        const last = blocks[blocks.length - 1];
        expect(last.text.text).toMatch(/cancelled/);
    });
    it('refuses to render an unrecognized user id as a live mention', () => {
        const blocks = clarifyResolvedBlocks({
            question: 'Q?',
            answer: 'a',
            source: 'user',
            answeredBy: 'definitely-not-a-slack-user-id',
        });
        const ctx = blocks.find((b) => b.type === 'context');
        expect(ctx?.elements[0]?.text).not.toContain('<@');
    });
});
describe('clarifyModalView', () => {
    it('encodes requestId in private_metadata and uses the contracted block_id/action_id', () => {
        const view = clarifyModalView({ requestId: 'r9', question: 'free-form?' });
        expect(view.callback_id).toBe(CLARIFY_MODAL_CALLBACK_ID);
        expect(JSON.parse(view.private_metadata)).toEqual({ requestId: 'r9' });
        const input = view.blocks.find((b) => b.type === 'input');
        expect(input?.block_id).toBe(CLARIFY_MODAL_INPUT_BLOCK_ID);
        expect(input?.element?.action_id).toBe(CLARIFY_MODAL_INPUT_ACTION_ID);
    });
});
describe('action_id constants — stable contract', () => {
    it('keeps the choice/cancel/answer ids that adapter.start() registers on', () => {
        expect(CLARIFY_CHOICE_ACTION_ID).toBe('ethos_clarify_choice');
        expect(CLARIFY_CANCEL_ACTION_ID).toBe('ethos_clarify_cancel');
        expect(CLARIFY_ANSWER_ACTION_ID).toBe('ethos_clarify_answer');
    });
});

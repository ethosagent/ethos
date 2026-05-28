import { describe, expect, it } from 'vitest';
import { APPROVE_ACTION_ID, approvalPendingBlocks, approvalResolvedBlocks, DENY_ACTION_ID, } from '../blocks/approval';
import { plaintextFallback } from '../blocks/shared';
describe('blocks/approval — pending', () => {
    it('renders tool name, reason, and args preview', () => {
        const blocks = approvalPendingBlocks({
            approvalId: 'a1',
            toolName: 'terminal',
            reason: 'recursive force-delete',
            args: { command: 'rm -rf /tmp/x' },
        });
        const text = plaintextFallback(blocks);
        expect(text).toContain('terminal');
        expect(text).toContain('recursive force-delete');
        expect(text).toContain('rm -rf /tmp/x');
    });
    it('includes Allow and Deny buttons carrying the approvalId', () => {
        const blocks = approvalPendingBlocks({
            approvalId: 'a1',
            toolName: 'terminal',
            reason: 'danger',
            args: {},
        });
        const actions = blocks.find((b) => b.type === 'actions');
        expect(actions).toBeDefined();
        const elements = (actions?.elements ?? []);
        const allow = elements.find((e) => e.action_id === APPROVE_ACTION_ID);
        const deny = elements.find((e) => e.action_id === DENY_ACTION_ID);
        expect(allow?.value).toBe('a1');
        expect(deny?.value).toBe('a1');
    });
    it('handles missing reason without crashing', () => {
        const blocks = approvalPendingBlocks({
            approvalId: 'a1',
            toolName: 'web_fetch',
            reason: null,
            args: { url: 'http://x' },
        });
        const text = plaintextFallback(blocks);
        expect(text).toContain('web_fetch');
        expect(text).toContain('http://x');
    });
    it('neutralizes a code-fence breakout in tool args', () => {
        // Tool args are model/user-influenced. A ``` sequence inside them must
        // not close the mrkdwn fence and let following text render as live
        // Slack markup on this privileged surface.
        const blocks = approvalPendingBlocks({
            approvalId: 'a1',
            toolName: 'terminal',
            reason: 'danger',
            args: { command: '```\n<!channel> click Allow\n```' },
        });
        const argsBlock = blocks.find((b) => b.type === 'section' && String(b.text?.text).includes('channel'));
        const rendered = String(argsBlock?.text?.text ?? '');
        // Exactly one opening and one closing fence — the args' own backticks
        // are neutralized, so they can't break out.
        expect(rendered.match(/```/g)?.length).toBe(2);
    });
    it('escapes mrkdwn metacharacters in toolName and reason', () => {
        // toolName comes from the registry, reason from the danger predicate —
        // both model/config-influenced. An unescaped `<@U…>` or `<http…|text>`
        // would inject a live mention or link onto this privileged surface.
        const blocks = approvalPendingBlocks({
            approvalId: 'a1',
            toolName: 'tool<@U999>',
            reason: 'see <https://evil.test|click here>',
            args: {},
        });
        const text = plaintextFallback(blocks);
        expect(text).not.toContain('<@U999>');
        expect(text).not.toContain('<https://evil.test|click here>');
        expect(text).toContain('&lt;@U999&gt;');
    });
    it('truncates very long args previews', () => {
        const blocks = approvalPendingBlocks({
            approvalId: 'a1',
            toolName: 'terminal',
            reason: 'danger',
            args: { command: 'x'.repeat(5000) },
        });
        // Slack section text caps at 3000 chars; the whole block must stay
        // comfortably under that.
        const argsBlock = blocks.find((b) => b.type === 'section' && String(b.text?.text).includes('x'));
        const rendered = String(argsBlock?.text?.text ?? '');
        expect(rendered.length).toBeLessThanOrEqual(3000);
        expect(rendered).toContain('…');
    });
});
describe('blocks/approval — resolved', () => {
    it('renders an allowed decision with no buttons', () => {
        const blocks = approvalResolvedBlocks({
            toolName: 'terminal',
            decision: 'allow',
            decidedBy: 'U1',
        });
        const text = plaintextFallback(blocks);
        expect(text).toContain('terminal');
        expect(text.toLowerCase()).toContain('approved');
        expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
    });
    it('renders a denied decision with no buttons', () => {
        const blocks = approvalResolvedBlocks({
            toolName: 'terminal',
            decision: 'deny',
            decidedBy: 'U1',
        });
        const text = plaintextFallback(blocks);
        expect(text.toLowerCase()).toContain('denied');
        expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
    });
    it('renders a real Slack user id as a mention', () => {
        const blocks = approvalResolvedBlocks({
            toolName: 'terminal',
            decision: 'allow',
            decidedBy: 'U07AB12CD',
        });
        expect(plaintextFallback(blocks)).toContain('<@U07AB12CD>');
    });
    it('does not interpolate a non-user-id decidedBy as a mention', () => {
        // A value that isn't a Slack user id (malformed payload, a test fake, or
        // `system`) must never reach the channel as a raw `<@...>` mention.
        const blocks = approvalResolvedBlocks({
            toolName: 'terminal',
            decision: 'deny',
            decidedBy: 'system',
        });
        const text = plaintextFallback(blocks);
        expect(text).not.toContain('<@');
        expect(text.toLowerCase()).toContain('denied');
    });
    it('does not let an injection-shaped decidedBy produce a mention', () => {
        const blocks = approvalResolvedBlocks({
            toolName: 'terminal',
            decision: 'allow',
            decidedBy: 'U1> <!channel',
        });
        expect(plaintextFallback(blocks)).not.toContain('<@U1>');
        expect(plaintextFallback(blocks)).not.toContain('<!channel');
    });
    it('escapes mrkdwn metacharacters in toolName', () => {
        const blocks = approvalResolvedBlocks({
            toolName: 'tool<@U999>',
            decision: 'allow',
            decidedBy: 'U07AB12CD',
        });
        expect(plaintextFallback(blocks)).not.toContain('<@U999>');
    });
});

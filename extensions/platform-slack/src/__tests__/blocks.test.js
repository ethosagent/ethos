import { describe, expect, it } from 'vitest';
import { channelModeSetBlocks, channelModeShowBlocks, channelModeUsageBlocks, } from '../blocks/channel-mode';
import { helpBlocks } from '../blocks/help';
import { kanbanListBlocks } from '../blocks/kanban';
import { memoryAddedBlocks, memoryShowBlocks } from '../blocks/memory';
import { personalityBlocks, personalityRichBlocks, } from '../blocks/personality';
import { divider, header, plaintextFallback, section } from '../blocks/shared';
describe('blocks/shared', () => {
    it('section produces a mrkdwn section block', () => {
        expect(section('hello')).toEqual({
            type: 'section',
            text: { type: 'mrkdwn', text: 'hello' },
        });
    });
    it('header produces a plain_text header block', () => {
        const block = header('Title');
        expect(block.type).toBe('header');
        expect(block.text.text).toBe('Title');
    });
    it('divider produces a divider block', () => {
        expect(divider()).toEqual({ type: 'divider' });
    });
    it('plaintextFallback flattens header + section + context, leaves mrkdwn intact', () => {
        const blocks = [header('Title'), section('hello *world*'), divider()];
        expect(plaintextFallback(blocks)).toBe('Title\nhello *world*');
    });
});
describe('blocks/help', () => {
    it('renders binding + channel mode + commands', () => {
        const blocks = helpBlocks({
            binding: { type: 'personality', name: 'researcher' },
            channel: 'C1',
            channelMode: 'all',
        });
        const fallback = plaintextFallback(blocks);
        expect(fallback).toContain('Ethos');
        expect(fallback).toContain('researcher');
        expect(fallback).toContain('all');
        expect(fallback).toContain('/ethos ask');
        expect(fallback).toContain('/ethos channel-mode');
    });
});
describe('blocks/personality', () => {
    it('describes personality bots', () => {
        const blocks = personalityBlocks({ type: 'personality', name: 'coder' });
        expect(plaintextFallback(blocks)).toContain('personality');
        expect(plaintextFallback(blocks)).toContain('coder');
    });
    it('describes team-coordinator bots', () => {
        const blocks = personalityBlocks({ type: 'team', name: 'eng' });
        expect(plaintextFallback(blocks)).toContain('team coordinator');
        expect(plaintextFallback(blocks)).toContain('eng');
    });
    const richCard = {
        id: 'engineer',
        name: 'Engineer',
        description: 'Writes and ships code.',
        prose: 'I think in tradeoffs.',
        model: 'claude-opus-4-7',
        provider: 'anthropic',
        toolset: ['read_file', 'bash'],
        skills: [
            { id: 'code-review', source: 'personality' },
            { id: 'git-workflow', source: 'global' },
        ],
    };
    it('renders the rich card with identity, tools, and resolved skills', () => {
        const text = plaintextFallback(personalityRichBlocks(richCard));
        expect(text).toContain('Engineer');
        expect(text).toContain('I think in tradeoffs.');
        expect(text).toContain('2 tools');
        expect(text).toContain('read_file · bash');
        expect(text).toContain('2 skills');
        expect(text).toContain('code-review');
        expect(text).toContain('(global)');
    });
    it('renders honest empty states for a tool-less, skill-less personality', () => {
        const text = plaintextFallback(personalityRichBlocks({ ...richCard, toolset: [], skills: [] }));
        expect(text).toContain('0 tools');
        expect(text).toContain('can only converse');
        expect(text).toContain('0 skills');
        expect(text).toContain('No skills resolved');
    });
    it('omits filesystem reach, MCP servers, and plugins (recon-sensitive)', () => {
        const text = plaintextFallback(personalityRichBlocks(richCard));
        expect(text).not.toContain('Filesystem');
        expect(text).not.toContain('MCP');
        expect(text).not.toContain('Plugins');
    });
});
describe('blocks/channel-mode', () => {
    it('show identifies override vs default source', () => {
        const blocks = channelModeShowBlocks({ channel: 'C1', mode: 'all', isOverride: true });
        expect(plaintextFallback(blocks)).toContain('per-channel override');
        const blocks2 = channelModeShowBlocks({ channel: 'C1', mode: 'all', isOverride: false });
        expect(plaintextFallback(blocks2)).toContain('app default');
    });
    it('set acknowledges new mode', () => {
        const blocks = channelModeSetBlocks({ channel: 'C1', mode: 'thread_follow' });
        expect(plaintextFallback(blocks)).toContain('thread_follow');
    });
    it('usage lists all valid modes', () => {
        const text = plaintextFallback(channelModeUsageBlocks());
        expect(text).toContain('mention_only');
        expect(text).toContain('thread_follow');
        expect(text).toContain('all');
    });
});
describe('blocks/memory', () => {
    it('renders empty memory clearly', () => {
        const blocks = memoryShowBlocks({ scope: 'researcher', entries: [] });
        expect(plaintextFallback(blocks)).toContain('empty');
    });
    it('renders entries in order', () => {
        const blocks = memoryShowBlocks({
            scope: 'researcher',
            entries: ['- one thing', '- two things'],
        });
        const text = plaintextFallback(blocks);
        expect(text.indexOf('one thing')).toBeLessThan(text.indexOf('two things'));
    });
    it('append confirmation truncates long previews', () => {
        const long = 'x'.repeat(500);
        const blocks = memoryAddedBlocks({ scope: 'researcher', preview: long });
        const text = plaintextFallback(blocks);
        expect(text).toContain('Appended');
        expect(text).toContain('…');
    });
});
describe('blocks/kanban', () => {
    it('renders empty kanban clearly', () => {
        const blocks = kanbanListBlocks({ team: 'eng', tickets: [] });
        expect(plaintextFallback(blocks)).toContain('No open tickets');
    });
    it('renders ticket title, status, and assignee', () => {
        const blocks = kanbanListBlocks({
            team: 'eng',
            tickets: [
                { id: 't1', title: 'fix bug', status: 'todo', assignee: 'alice' },
                { id: 't2', title: 'ship feature', status: 'running', assignee: null },
            ],
        });
        const text = plaintextFallback(blocks);
        expect(text).toContain('fix bug');
        expect(text).toContain('todo');
        expect(text).toContain('alice');
        expect(text).toContain('ship feature');
        expect(text).toContain('unassigned');
    });
});

// Pure tests for the Discord clarify interaction parsers.
import { describe, expect, it, vi } from 'vitest';
import { CLARIFY_ANSWER_KIND, CLARIFY_BUTTON_PREFIX, CLARIFY_CANCEL_KIND, CLARIFY_CHOICE_KIND, CLARIFY_MODAL_KIND, } from '../clarify-blocks';
import { handleClarifyButton, handleClarifyModal } from '../clarify-interactions';
function buttonPayload(customId, overrides = {}) {
    return {
        customId,
        userId: 'U1',
        channelId: 'C1',
        messageId: 'M1',
        ...overrides,
    };
}
describe('handleClarifyButton', () => {
    it('routes a valid choice click', async () => {
        const onEvent = vi.fn();
        await handleClarifyButton(buttonPayload(`${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1:2`), { onEvent });
        expect(onEvent).toHaveBeenCalledWith({
            kind: 'choice',
            requestId: 'r1',
            choiceIndex: 2,
            userId: 'U1',
            channelId: 'C1',
            messageId: 'M1',
        });
    });
    it('routes a cancel click', async () => {
        const onEvent = vi.fn();
        await handleClarifyButton(buttonPayload(`${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CANCEL_KIND}:r1`), {
            onEvent,
        });
        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cancel', requestId: 'r1' }));
    });
    it('routes an open-modal click', async () => {
        const onEvent = vi.fn();
        await handleClarifyButton(buttonPayload(`${CLARIFY_BUTTON_PREFIX}:${CLARIFY_ANSWER_KIND}:r1`), {
            onEvent,
        });
        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'open-modal', requestId: 'r1' }));
    });
    it('drops anonymous clicks', async () => {
        const onEvent = vi.fn();
        await handleClarifyButton({ ...buttonPayload(`${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1:0`), userId: '' }, { onEvent });
        expect(onEvent).not.toHaveBeenCalled();
    });
    it('drops malformed customIds', async () => {
        const onEvent = vi.fn();
        for (const id of [
            'no-colons',
            'wrong:prefix:r1:0',
            `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1:notanumber`,
            `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1`,
        ]) {
            await handleClarifyButton(buttonPayload(id), { onEvent });
        }
        expect(onEvent).not.toHaveBeenCalled();
    });
    it('swallows callback errors', async () => {
        const onEvent = vi.fn().mockRejectedValue(new Error('stale'));
        await expect(handleClarifyButton(buttonPayload(`${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1:0`), {
            onEvent,
        })).resolves.toBeUndefined();
    });
});
describe('handleClarifyModal', () => {
    it('parses requestId and forwards the answer', async () => {
        const onEvent = vi.fn();
        await handleClarifyModal({
            customId: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_MODAL_KIND}:r1`,
            userId: 'U1',
            channelId: 'C1',
            answer: 'normalized 3NF',
        }, { onEvent });
        expect(onEvent).toHaveBeenCalledWith({
            kind: 'modal-submit',
            requestId: 'r1',
            answer: 'normalized 3NF',
            userId: 'U1',
            channelId: 'C1',
        });
    });
    it('drops empty answer', async () => {
        const onEvent = vi.fn();
        await handleClarifyModal({
            customId: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_MODAL_KIND}:r1`,
            userId: 'U1',
            channelId: 'C1',
            answer: '',
        }, { onEvent });
        expect(onEvent).not.toHaveBeenCalled();
    });
    it('drops payloads with the wrong prefix or kind', async () => {
        const onEvent = vi.fn();
        await handleClarifyModal({ customId: 'wrong:prefix:r1', userId: 'U1', channelId: 'C1', answer: 'a' }, { onEvent });
        await handleClarifyModal({
            customId: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:r1`,
            userId: 'U1',
            channelId: 'C1',
            answer: 'a',
        }, { onEvent });
        expect(onEvent).not.toHaveBeenCalled();
    });
});

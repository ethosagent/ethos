// @vitest-environment jsdom

// Communications > Rooms (plan/phases/channel-prompts-ui.md L5); shared mocks and helpers in rooms-section.fixtures.ts.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import {
  botsSlackFn,
  button,
  byText,
  choose,
  click,
  deleteFn,
  drawer,
  entry,
  field,
  installRoomsHarness,
  listFn,
  listResponse,
  mount,
  openAdd,
  PREVIEW_DEBOUNCE_MS,
  personalitySkillsFn,
  previewFn,
  previewResponse,
  row,
  rpcError,
  setFn,
  type,
  waitMs,
} from './rooms-section.fixtures';

installRoomsHarness();

describe('Rooms table', () => {
  it('lists the pinned rows first, then entries with chips, counter and source', async () => {
    listFn.mockResolvedValue(
      listResponse('slack', [
        entry('C0DEPLOY', {
          fields: { mode: 'thread_follow', skills: ['code-review'], tier: 'deep' },
          prompt: { text: 'x'.repeat(2140), chars: 2140, source: 'file', path: 'p' },
          source: 'both',
        }),
        entry('*', { kind: 'rooms', fields: { silent: true } }),
      ]),
    );
    await mount('slack');

    const rows = [...document.body.querySelectorAll('[data-selector]')].map((r) =>
      r.getAttribute('data-selector'),
    );
    expect(rows).toEqual(['*', '*dm', 'C0DEPLOY']);
    expect(row('*').textContent).toContain('All channels');
    expect(row('*dm').textContent).toContain('All DMs');
    expect(row('*dm').textContent).toContain('not set');
    const deploy = row('C0DEPLOY').textContent ?? '';
    expect(deploy).toContain('thread_follow');
    expect(deploy).toContain('code-review');
    expect(deploy).toContain('tier: deep');
    expect(deploy).toContain('2,140 / 4,000');
    expect(deploy).toContain('file + config');
    expect(row('*').textContent).toContain('silent');
  });

  it('shows the empty state copy and keeps the pinned rows', async () => {
    await mount('slack');
    expect(document.body.textContent).toContain('No room rules for Slack.');
    expect(document.body.textContent).toContain(
      'Every room uses the personality as-is. Add a room to give one channel its own instructions.',
    );
    expect(document.body.querySelectorAll('[data-selector]').length).toBe(2);
  });

  it('labels the pinned rows "All groups" on Telegram', async () => {
    await mount('telegram');
    expect(row('*').textContent).toContain('All groups');
    expect(document.body.textContent).toContain('No room rules for Telegram.');
  });

  it('shows a row warning beside the entry', async () => {
    listFn.mockResolvedValue(
      listResponse('slack', [entry('C0SUPPORT', { warnings: ["model 'fast' is not an alias"] })]),
    );
    await mount('slack');
    expect(row('C0SUPPORT').textContent).toContain("model 'fast' is not an alias");
  });
});

describe('Add and edit', () => {
  it('add -> save sends expectedVersion null and shows the restart notice', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await type(field<HTMLTextAreaElement>('Room prompt'), 'Confirm service first.');
    await click(button('Save'));

    expect(setFn).toHaveBeenCalledTimes(1);
    expect(setFn).toHaveBeenCalledWith({
      platform: 'slack',
      selector: 'C0DEPLOY',
      entry: { prompt: 'Confirm service first.' },
      expectedVersion: null,
    });
    expect(drawer()).toBeNull();
    const status = document.body.querySelector('[data-testid="rooms-restart-notice"]');
    expect(status?.textContent).toContain('Saved. Restart the gateway to apply.');
    expect(status?.textContent).toContain('gateway restart');
    // No restart button in v1 (plan D17).
    expect(byText('button', /restart/i)).toBeNull();
    // The list was refetched.
    expect(listFn.mock.calls.length).toBeGreaterThan(1);
  });

  it('edit sends the version the row carried', async () => {
    listFn.mockResolvedValue(
      listResponse('slack', [
        entry('C0DEPLOY', {
          version: 'abc123',
          fields: { mode: 'all' },
          prompt: { text: 'hello', chars: 5, source: 'file', path: 'p' },
        }),
      ]),
    );
    await mount('slack');
    await click(button('Edit', row('C0DEPLOY')));

    expect(field<HTMLTextAreaElement>('Room prompt').value).toBe('hello');
    expect(field<HTMLInputElement>('Channel ID').value).toBe('C0DEPLOY');
    expect(field<HTMLInputElement>('Channel ID').readOnly).toBe(true);
    await click(button('Save'));
    expect(setFn).toHaveBeenCalledWith({
      platform: 'slack',
      selector: 'C0DEPLOY',
      entry: { prompt: 'hello', mode: 'all' },
      expectedVersion: 'abc123',
    });
  });

  it('a pinned row with no entry opens with its wildcard fixed', async () => {
    await mount('slack');
    await click(button('Set', row('*dm')));
    expect(field<HTMLInputElement>('Channel ID').value).toBe('*dm');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0]).toMatchObject({ selector: '*dm', expectedVersion: null });
  });

  it('model and tier are one choice: picking a tier sends tier only', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await choose(field<HTMLSelectElement>('Model'), 'alias:sonnet-main');
    await choose(field<HTMLSelectElement>('Model'), 'tier:deep');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0].entry).toEqual({ prompt: '', tier: 'deep' });
  });

  it('a mode picked from the select is sent', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await choose(field<HTMLSelectElement>('Mode'), 'observe');
    expect(document.body.textContent).toContain('Reads, never answers (digest only).');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0].entry).toEqual({ prompt: '', mode: 'observe' });
  });

  it('Esc closes the drawer', async () => {
    await mount('slack');
    await openAdd();
    expect(drawer()).not.toBeNull();
    const target = field<HTMLInputElement>('Channel ID');
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }),
      );
    });
    await waitMs(400);
    expect(document.body.querySelector('.ant-drawer-open')).toBeNull();
  });
});

describe('Errors and validation', () => {
  it('409 shows the conflict copy and re-fetches the list', async () => {
    listFn.mockResolvedValue(listResponse('slack', [entry('C0DEPLOY', { version: 'old' })]));
    setFn.mockRejectedValueOnce(rpcError('CONFIG_CONFLICT', 'expectedVersion old is stale'));
    await mount('slack');
    const before = listFn.mock.calls.length;
    listFn.mockResolvedValue(listResponse('slack', [entry('C0DEPLOY', { version: 'fresh' })]));
    await click(button('Edit', row('C0DEPLOY')));
    await click(button('Save'));

    expect(drawer()?.textContent).toContain('Changed elsewhere');
    expect(drawer()?.textContent).toContain('reloaded');
    expect(listFn.mock.calls.length).toBeGreaterThan(before);
    // The next save carries the fresh version.
    await click(button('Save'));
    expect(setFn).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 'fresh' }));
  });

  it("offers a bound bot personality's skills, so they are not flagged as unknown", async () => {
    botsSlackFn.mockResolvedValue({
      bots: [{ botKey: 'k', bind: { type: 'personality', name: 'ops' } }],
    });
    personalitySkillsFn.mockResolvedValue({ skills: [{ id: 'bot-only-skill' }] });
    listFn.mockResolvedValue(
      listResponse('slack', [
        entry('C0DEPLOY', { fields: { skills: ['bot-only-skill', 'nope'] } }),
      ]),
    );
    await mount('slack');
    await click(button('Edit', row('C0DEPLOY')));
    expect(personalitySkillsFn).toHaveBeenCalledWith({ personalityId: 'ops' });
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('Not an installed skill: nope.');
    expect(text).not.toContain('bot-only-skill.');
  });

  it('partial shows which half landed and Retry resends the identical request', async () => {
    setFn.mockResolvedValueOnce({
      ok: false,
      reason: 'partial',
      fileWritten: true,
      fileRemoved: false,
      configWritten: false,
      cause: 'config.yaml write failed: EACCES',
    });
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await type(field<HTMLTextAreaElement>('Room prompt'), 'hi');
    await click(button('Save'));

    const text = drawer()?.textContent ?? '';
    expect(text).toContain('prompt file was written');
    expect(text).toContain('config.yaml was not updated');
    expect(text).toContain('EACCES');
    // Typing now must not change what Retry sends.
    await type(field<HTMLTextAreaElement>('Room prompt'), 'hi, edited after');
    await click(button('Retry'));
    expect(setFn).toHaveBeenCalledTimes(2);
    expect(setFn.mock.calls[1]?.[0]).toEqual(setFn.mock.calls[0]?.[0]);
    expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).not.toBeNull();
  });

  it('partial after a blank prompt removed the file says removed, not not written', async () => {
    setFn.mockResolvedValueOnce({
      ok: false,
      reason: 'partial',
      fileWritten: false,
      fileRemoved: true,
      configWritten: false,
      cause: 'config.yaml write failed: EACCES',
    });
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await click(button('Save'));
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('prompt file was removed');
    expect(text).not.toContain('was not written');
  });

  it('a delete that lands in part offers Retry with the same request', async () => {
    listFn.mockResolvedValue(listResponse('slack', [entry('C0DEPLOY', { version: 'v9' })]));
    deleteFn.mockResolvedValueOnce({
      ok: false,
      reason: 'partial',
      fileRemoved: true,
      configRemoved: false,
      cause: 'EACCES',
    });
    await mount('slack');
    await click(button('Edit', row('C0DEPLOY')));
    await click(button('Delete'));
    await click(button('Confirm delete'));
    expect(drawer()?.textContent).toContain('prompt file was removed');
    await click(button('Retry'));
    expect(deleteFn).toHaveBeenCalledTimes(2);
    expect(deleteFn.mock.calls[1]?.[0]).toEqual(deleteFn.mock.calls[0]?.[0]);
  });

  it('over 4,000 characters disables Save and says by how much', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await type(field<HTMLTextAreaElement>('Room prompt'), 'x'.repeat(4001));
    expect(drawer()?.textContent).toContain('4,001 / 4,000');
    expect(button('Save').disabled).toBe(true);
    await type(field<HTMLTextAreaElement>('Room prompt'), 'x'.repeat(4000));
    expect(button('Save').disabled).toBe(false);
  });

  it('a 413 from the server is shown and nothing is claimed saved', async () => {
    setFn.mockRejectedValueOnce(
      rpcError('PAYLOAD_TOO_LARGE', 'Prompt is 4,213 chars after template-token sanitising'),
    );
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await click(button('Save'));
    expect(drawer()?.textContent).toContain('4,213 chars');
    expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).toBeNull();
  });

  it('an unusual but path-safe id warns and still saves', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'c0deploy');
    expect(drawer()?.textContent).toContain('does not look like a Slack channel id');
    expect(button('Save').disabled).toBe(false);
    await click(button('Save'));
    expect(setFn).toHaveBeenCalledTimes(1);
  });

  it('a path-unsafe id is refused inline and blocks Save', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0/X');
    expect(drawer()?.querySelector('[role="alert"]')?.textContent).toContain("cannot contain '/'");
    expect(button('Save').disabled).toBe(true);
  });

  it('a server refusal in the preview blocks Save; server warnings stay savable', async () => {
    previewFn.mockRejectedValue(
      rpcError('INVALID_INPUT', "channels.slack.C0DEPLOY.mode: 'bogus' is not a reply mode"),
    );
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);
    expect(drawer()?.textContent).toContain("'bogus' is not a reply mode");
    expect(button('Save').disabled).toBe(true);

    previewFn.mockImplementation(async () =>
      previewResponse({ warnings: ["skill 'zzz' not found for C0DEPLOY"] }),
    );
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY2');
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);
    expect(button('Save').disabled).toBe(false);
  });

  it('preview warnings: the template-token one shows, and Saved anyway is never doubled', async () => {
    previewFn.mockImplementation(async () =>
      previewResponse({
        warnings: [
          "Room id 'C0DEPLOY' does not look like a Slack channel id. Saved anyway.",
          "Template tokens in the prompt for 'C0DEPLOY' are stripped when the gateway loads it.",
        ],
      }),
    );
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('Template tokens in the prompt');
    expect(text).not.toContain('Saved anyway. Saved anyway.');
    expect(text.match(/Saved anyway\./g)?.length).toBe(2);
  });

  it('a 400 on save shows the server sentence', async () => {
    setFn.mockRejectedValueOnce(rpcError('INVALID_INPUT', 'skill cannot contain a comma'));
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await click(button('Save'));
    expect(drawer()?.textContent).toContain('skill cannot contain a comma');
  });
});

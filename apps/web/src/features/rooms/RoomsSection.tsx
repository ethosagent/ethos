import type { RoomEntryFields, RoomEntryView, RoomPlatform } from '@ethosagent/web-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Skeleton, Switch } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '../../components/ui/EmptyState';
import { errorCode } from '../../lib/recipes';
import { APPLIES_BADGE } from '../../pages/settings/lib/applies';
import { rpc } from '../../rpc';
import { roomKeys } from '../communications/api/keys';
import {
  useRecentRooms,
  useRoomModelAliases,
  useRoomPolicies,
  useRoomSkillOptions,
} from '../communications/api/queries';
import { wakeAge } from '../voice/satellite-rows';
import { type DrawerError, RoomDrawer } from './RoomDrawer';
import {
  buildRows,
  channelCommand,
  hasMetadataSource,
  platformLabel,
  promptCounter,
  roomNoun,
  rowChips,
  sourceLabel,
} from './room-rows';

// Communications > Rooms (plan/phases/channel-prompts-ui.md §3.6).
//
// Not a Card (DESIGN.md "Cards earn existence"): a micro-label heading, a
// grid of rows, and the drawer. The page that mounts this already sits inside
// the platform panel; this section adds no second container.
//
// The restart notice is component state on purpose (plan D18): no RPC exposes
// the gateway's boot time, so a notice that survived a reload would be a guess.
// There is no restart button either (D17); the notice names the step.

type SetInput = Parameters<typeof rpc.platforms.setRoomPolicy>[0];
type DeleteInput = Parameters<typeof rpc.platforms.deleteRoomPolicy>[0];
type Pending = { kind: 'set'; input: SetInput } | { kind: 'delete'; input: DeleteInput };

interface DrawerState {
  /** Remounts the drawer, and with it the form, for every open. */
  key: number;
  fixedSelector: string | null;
  entry: RoomEntryView | null;
  prefillId: string;
  isDm: boolean;
  /** Captured at open, never re-read from a background refetch, so
   *  `expectedVersion` always means "the version the operator saw". Moves only
   *  after a 409, when the list has been re-fetched on purpose. */
  baseVersion: string | null;
}

interface Notice {
  text: string;
  warnings: string[];
}

const BADGE = APPLIES_BADGE['gateway-restart'];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function RestartBadge() {
  return (
    <span className="rooms-badge" title="Room rules are read once when the gateway starts">
      {BADGE.glyph} {BADGE.word}
    </span>
  );
}

export function RoomsSection({ platform }: { platform: RoomPlatform }) {
  const qc = useQueryClient();
  const list = useRoomPolicies(platform);
  const recent = useRecentRooms(platform);
  const skills = useRoomSkillOptions(platform);
  const registry = useRoomModelAliases();

  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [drawerError, setDrawerError] = useState<DrawerError | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState<{ message: string; retry?: () => void } | null>(
    null,
  );
  const openCount = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const scrolled = useRef(false);

  const label = platformLabel(platform);
  const noun = roomNoun(platform);
  const ready = list.isSuccess;

  // `?tab=<platform>#rooms`: the tab is chosen by the page, the scroll here.
  // antd mounts a pane when first shown, so the section that mounts under a
  // `#rooms` link is the active platform's; ids are per platform because
  // visited panes stay mounted. Waits for the list so the section has its real height first.
  useEffect(() => {
    if (
      !ready ||
      scrolled.current ||
      (window.location.hash !== '#rooms' && window.location.hash !== `#rooms-${platform}`)
    )
      return;
    scrolled.current = true;
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [ready, platform]);

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: roomKeys.list(platform) }),
      qc.invalidateQueries({ queryKey: roomKeys.recent(platform) }),
    ]);
  };

  const openDrawer = (s: Omit<DrawerState, 'key'>) => {
    openCount.current += 1;
    setDrawerError(null);
    setDrawer({ ...s, key: openCount.current });
  };

  const openEntry = (selector: string, entry: RoomEntryView | null) =>
    openDrawer({
      fixedSelector: selector,
      entry,
      prefillId: '',
      isDm: selector === '*dm',
      baseVersion: entry?.version ?? null,
    });

  const openNew = (prefillId = '', isDm = false) =>
    openDrawer({ fixedSelector: null, entry: null, prefillId, isDm, baseVersion: null });

  const send = async (pending: Pending): Promise<void> => {
    setBusy(true);
    setDrawerError(null);
    const retry = () => void send(pending);
    try {
      if (pending.kind === 'set') {
        const res = await rpc.platforms.setRoomPolicy(pending.input);
        if (!res.ok) {
          setDrawerError({
            kind: 'partial',
            message: `Saved in part. The prompt file ${res.fileWritten ? 'was written' : res.fileRemoved ? 'was removed' : 'was not changed'}, and config.yaml ${res.configWritten ? 'was updated' : 'was not updated'}: ${res.cause}`,
            retry,
          });
          return;
        }
        setNotice({ text: 'Saved.', warnings: res.warnings });
      } else {
        const res = await rpc.platforms.deleteRoomPolicy(pending.input);
        if (!res.ok) {
          setDrawerError({
            kind: 'partial',
            message: `Deleted in part. The prompt file ${res.fileRemoved ? 'was removed' : 'was not removed'}, and the config.yaml lines ${res.configRemoved ? 'were removed' : 'were not removed'}: ${res.cause}`,
            retry,
          });
          return;
        }
        setNotice({ text: 'Deleted.', warnings: [] });
      }
      setDrawer(null);
      await refreshAll();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'CONFIG_CONFLICT') {
        // Re-fetch on purpose, and carry the fresh version into the next save:
        // the operator has been told, and their edit is still in the form.
        const fresh = await list.refetch();
        const selector = pending.input.selector;
        const version = fresh.data?.entries.find((e) => e.selector === selector)?.version ?? null;
        setDrawer((d) => (d ? { ...d, baseVersion: version } : d));
        setDrawerError({
          kind: 'conflict',
          message:
            'Changed elsewhere — reloaded. Re-apply your edit. It is still in the form: Save again to replace what changed.',
        });
      } else if (code === 'PAYLOAD_TOO_LARGE') {
        setDrawerError({ kind: 'too_large', message: message(err) });
      } else if (code === 'INVALID_INPUT') {
        setDrawerError({ kind: 'refused', message: message(err) });
      } else {
        setDrawerError({
          kind: 'failed',
          message: `Could not reach the gateway API: ${message(err)}`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const save = (selector: string, entry: RoomEntryFields) => {
    if (!drawer) return;
    void send({
      kind: 'set',
      input: { platform, selector, entry, expectedVersion: drawer.baseVersion },
    });
  };

  const remove = () => {
    if (!drawer?.entry || drawer.fixedSelector === null) return;
    void send({
      kind: 'delete',
      input: {
        platform,
        selector: drawer.fixedSelector,
        expectedVersion: drawer.baseVersion ?? drawer.entry.version,
      },
    });
  };

  const setFetchMetadata = async (next: boolean) => {
    const input = { platform, fetchMetadata: next };
    setSwitchBusy(true);
    setSwitchError(null);
    try {
      const res = await rpc.platforms.setRoomPlatformSettings(input);
      if (!res.ok) {
        setSwitchError({
          message:
            res.reason === 'unsupported'
              ? `${label} has no room metadata source. ${res.cause}`
              : `Could not save Fetch room metadata: ${res.cause}`,
          ...(res.reason === 'partial' ? { retry: () => void setFetchMetadata(next) } : {}),
        });
        return;
      }
      setNotice({ text: 'Saved.', warnings: [] });
      await refreshAll();
    } catch (err) {
      setSwitchError({ message: message(err), retry: () => void setFetchMetadata(next) });
    } finally {
      setSwitchBusy(false);
    }
  };

  const data = list.data;
  const rows = data ? buildRows(platform, data.entries) : [];
  const fetchMetadata = data?.fetchMetadata ?? false;
  const hasEntries = (data?.entries.length ?? 0) > 0;
  const recentRooms = recent.data?.rooms ?? [];
  const now = Date.now();

  return (
    <section
      ref={sectionRef}
      id={`rooms-${platform}`}
      className="rooms"
      aria-labelledby={`rooms-heading-${platform}`}
    >
      <div className="rooms-head">
        <span className="rooms-micro" id={`rooms-heading-${platform}`}>
          Rooms
        </span>
        <RestartBadge />
        <span className="rooms-grow" />
        <Button onClick={() => openNew()}>Add room</Button>
      </div>
      <p className="rooms-intro">
        Give one {noun} its own instructions, skills or reply mode. Rooms without a rule use the
        personality as-is.
      </p>

      {notice ? (
        <Alert
          type="warning"
          showIcon={false}
          data-testid="rooms-restart-notice"
          message={
            <span className="rooms-notice">
              <RestartBadge />
              <span>
                <b>{notice.text}</b> Restart the gateway to apply. Room rules are read once when the
                gateway starts; a running gateway keeps the old rules until then.
              </span>
            </span>
          }
          description={
            notice.warnings.length > 0 ? (
              <ul className="rooms-notice-warnings">
                {notice.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : undefined
          }
        />
      ) : null}

      {list.isLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} title={false} />
      ) : list.isError ? (
        <Alert
          type="error"
          showIcon
          message={`Could not load room rules: ${list.error.message}`}
          action={
            <Button size="small" onClick={() => void list.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          {hasMetadataSource(platform) ? (
            <div className="rooms-setting">
              <Switch
                aria-label="Fetch room metadata"
                checked={fetchMetadata}
                loading={switchBusy}
                onChange={(v) => void setFetchMetadata(v)}
              />
              <div>
                <div className="rooms-setting-title">Fetch room metadata</div>
                <div className="rooms-small">
                  Reads each room's topic from {label} so a room's Metadata switch can use it. Needs
                  a gateway restart.
                </div>
              </div>
              <div className="rooms-readonly rooms-small">
                Name matching: <b>{data?.allowNameMatching ? 'on' : 'off'}</b>{' '}
                <span className="rooms-dim">(config only)</span>.{' '}
                {data?.allowNameMatching ? (
                  <>
                    <code>name:</code> selectors are accepted.
                  </>
                ) : (
                  <>
                    <code>name:</code> selectors are unavailable. Turn it on in config.yaml.
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="rooms-setting rooms-setting-plain">
              <div className="rooms-readonly rooms-small">
                Name matching: <b>{data?.allowNameMatching ? 'on' : 'off'}</b>{' '}
                <span className="rooms-dim">(config only)</span>.{' '}
                {data?.allowNameMatching ? (
                  <>
                    <code>name:</code> selectors are accepted.
                  </>
                ) : (
                  <>
                    <code>name:</code> selectors are unavailable. Turn it on in config.yaml.
                  </>
                )}
              </div>
            </div>
          )}
          {switchError ? (
            <Alert
              type="error"
              showIcon
              message={switchError.message}
              action={
                switchError.retry ? (
                  <Button size="small" onClick={switchError.retry} disabled={switchBusy}>
                    Retry
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {!hasEntries ? (
            <EmptyState
              title={`No room rules for ${label}.`}
              hint={`Every room uses the personality as-is. Add a room to give one ${noun} its own instructions.`}
            />
          ) : null}

          <div className="rooms-table">
            <div className="rooms-row rooms-hdr" aria-hidden="true">
              <div className="rooms-sel rooms-micro">Room</div>
              <div className="rooms-chips rooms-micro">Rule</div>
              <div className="rooms-size rooms-micro">Prompt</div>
              <div className="rooms-src rooms-micro">Source</div>
              <div className="rooms-act" />
            </div>
            {rows.map((r) => (
              <div
                key={r.key}
                data-selector={r.selector}
                className={`rooms-row${r.pinned ? ' rooms-pinned' : ''}${r.indent ? ' rooms-indent' : ''}`}
              >
                <div className="rooms-sel">
                  <span className="rooms-id">{r.selector}</span>
                  {r.label ? <span className="rooms-lbl">{r.label}</span> : null}
                </div>
                <div className="rooms-chips">
                  {rowChips(r.entry).map((c) => (
                    <span key={`${c.tone}:${c.text}`} className={`rooms-chip rooms-chip-${c.tone}`}>
                      {c.text}
                    </span>
                  ))}
                  {r.entry?.warnings.map((w) => (
                    <span key={w} className="rooms-row-warn">
                      ⚠ {w}
                    </span>
                  ))}
                </div>
                <div className={`rooms-size rooms-mono${r.entry ? '' : ' rooms-dim'}`}>
                  {r.entry ? promptCounter(r.entry.prompt.chars).text : '—'}
                </div>
                <div className={`rooms-src${r.entry ? '' : ' rooms-dim'}`}>
                  {sourceLabel(r.entry)}
                </div>
                <div className="rooms-act">
                  <Button
                    type="link"
                    size="small"
                    aria-label={`${r.entry ? 'Edit' : 'Set'} ${r.selector}`}
                    onClick={() => openEntry(r.selector, r.entry)}
                  >
                    {r.entry ? 'Edit' : 'Set'}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="rooms-recent">
            <span className="rooms-micro">Recently active rooms</span>
            {recentRooms.length === 0 ? (
              <p className="rooms-small">
                No recent rooms. The list fills once the gateway has answered in a room.
              </p>
            ) : (
              <>
                <ul>
                  {recentRooms.map((room) => {
                    const existing = data?.entries.find((e) => e.selector === room.chatId) ?? null;
                    return (
                      <li key={room.chatId}>
                        <span className="rooms-id">{room.chatId}</span>
                        {room.isDm === null ? null : (
                          <span className="rooms-chip rooms-chip-plain">
                            {room.isDm ? 'DM' : noun}
                          </span>
                        )}
                        <span className="rooms-when">
                          {wakeAge(Date.parse(room.lastActiveAt), now)}
                        </span>
                        {room.hasEntry && existing ? (
                          <Button
                            size="small"
                            onClick={() => openEntry(existing.selector, existing)}
                          >
                            Edit
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            onClick={() => openNew(room.chatId, room.isDm === true)}
                          >
                            Add
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {recent.data && recent.data.omittedCount > 0 ? (
                  <p className="rooms-small">{recent.data.omittedCount} older rooms not shown.</p>
                ) : null}
                <p className="rooms-small">Ids only. Titles and message text are never listed.</p>
              </>
            )}
          </div>

          <div className="rooms-addbar">
            <Button type="primary" onClick={() => openNew()}>
              Add room
            </Button>
            <span className="rooms-small">
              Or send <span className="rooms-mono">{channelCommand(platform)}</span> in the room.
              Its first line is the id.
            </span>
          </div>
        </>
      )}

      {drawer ? (
        <RoomDrawer
          key={drawer.key}
          platform={platform}
          fixedSelector={drawer.fixedSelector}
          entry={drawer.entry}
          prefillId={drawer.prefillId}
          isDm={drawer.isDm}
          fetchMetadata={fetchMetadata}
          skillIds={skills.data ? skills.data.ids : null}
          modelAliases={registry.data ? registry.data.entries.map((e) => e.alias) : []}
          busy={busy}
          error={drawerError}
          onSave={save}
          onDelete={remove}
          onClose={() => {
            setDrawer(null);
            setDrawerError(null);
          }}
        />
      ) : null}
    </section>
  );
}

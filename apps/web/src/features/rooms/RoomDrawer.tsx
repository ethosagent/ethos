import type { RoomEntryFields, RoomEntryView, RoomPlatform } from '@ethosagent/web-contracts';
import { Alert, Button, Drawer, Input, Select, Switch } from 'antd';
import { useEffect, useId, useMemo, useState } from 'react';
import { errorCode } from '../../lib/recipes';
import { useRoomPreview } from '../communications/api/queries';
import {
  channelCommand,
  checkRoomId,
  emptyForm,
  entryFromForm,
  formFromEntry,
  hasMetadataSource,
  platformLabel,
  previewInputFor,
  promptCounter,
  REGEX_MATCH_REFUSAL,
  ROOM_ID_HINTS,
  ROOM_MODE_DESCRIPTIONS,
  type RoomForm,
  roomFileName,
  roomNoun,
  SWITCH_DEFAULTS,
  selectableModes,
  selectorFromForm,
  TIERS,
} from './room-rows';

// The add/edit drawer (plan/phases/channel-prompts-ui.md §3.6, mockup
// rooms-mockup.html). Form state lives here; every RPC lives in RoomsSection,
// so a retry can resend exactly what was sent and this component stays a form.

/** The preview follows typing, but one request per pause, not per key. */
export const PREVIEW_DEBOUNCE_MS = 400;

export interface DrawerError {
  kind: 'conflict' | 'refused' | 'too_large' | 'partial' | 'failed';
  message: string;
  /** Present on a partial write: resends the identical request. */
  retry?: () => void;
}

export interface RoomDrawerProps {
  platform: RoomPlatform;
  /** Edit (or set a pinned wildcard): the selector cannot be changed. */
  fixedSelector: string | null;
  /** The saved entry; null for add and for a pinned row with nothing set. */
  entry: RoomEntryView | null;
  prefillId: string;
  isDm: boolean;
  fetchMetadata: boolean;
  skillIds: readonly string[] | null;
  modelAliases: readonly string[];
  busy: boolean;
  error: DrawerError | null;
  onSave: (selector: string, entry: RoomEntryFields) => void;
  onDelete: () => void;
  onClose: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rooms-sw">
      <Switch aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <div className="rooms-sw-title">{label}</div>
      <div className="rooms-sw-desc">{children}</div>
    </div>
  );
}

export function RoomDrawer(props: RoomDrawerProps) {
  const {
    platform,
    fixedSelector,
    entry,
    prefillId,
    isDm,
    fetchMetadata,
    skillIds,
    modelAliases,
    busy,
    error,
    onSave,
    onDelete,
    onClose,
  } = props;
  const ids = useId();
  const label = platformLabel(platform);
  const noun = roomNoun(platform);
  const idLabel = noun === 'channel' ? 'Channel ID' : 'Group ID';

  const [form, setForm] = useState<RoomForm>(() => {
    if (entry) return formFromEntry(entry);
    return { ...emptyForm(), roomId: fixedSelector ?? prefillId };
  });
  const [armed, setArmed] = useState(false);
  const patch = (p: Partial<RoomForm>) => setForm((f) => ({ ...f, ...p }));

  const selector = selectorFromForm(platform, form);
  const idCheck =
    fixedSelector !== null ? { error: null, warning: null } : checkRoomId(platform, selector);
  const counter = promptCounter(form.prompt.length);

  const previewInput = useMemo(() => previewInputFor(platform, form, isDm), [platform, form, isDm]);
  const settledInput = useDebounced(previewInput, PREVIEW_DEBOUNCE_MS);
  const preview = useRoomPreview(settledInput);
  const previewRefused =
    settledInput === previewInput &&
    preview.isError &&
    (errorCode(preview.error) === 'INVALID_INPUT' ||
      errorCode(preview.error) === 'PAYLOAD_TOO_LARGE');
  const previewWarnings = (preview.data?.warnings ?? []).filter(
    (w) => selector !== '' && w.includes(selector),
  );

  const saveBlocked =
    busy || selector === '' || idCheck.error !== null || counter.over || previewRefused;

  const modes = selectableModes(platform);
  const modeOptions =
    form.mode !== '' && !modes.includes(form.mode) ? [...modes, form.mode] : [...modes];
  const aliasList =
    form.model.startsWith('alias:') && !modelAliases.includes(form.model.slice(6))
      ? [...modelAliases, form.model.slice(6)]
      : [...modelAliases];
  const rawModel = modelAliases.length === 0;

  const eff = {
    silent: form.silent ?? SWITCH_DEFAULTS.silent,
    identity: form.identity ?? SWITCH_DEFAULTS.identity,
    metadata: form.metadata ?? SWITCH_DEFAULTS.metadata,
    inherit: form.inherit ?? SWITCH_DEFAULTS.inherit,
  };
  const metaSupported = hasMetadataSource(platform);
  const unknownSkills = skillIds === null ? [] : form.skills.filter((s) => !skillIds.includes(s));

  const note: string[] = [];
  if (preview.data?.identityLineOmitted ?? true) {
    note.push('Identity line omitted (the bot handle is only known to the running gateway).');
  }
  if (form.skills.length > 0) {
    note.push(`Skills (${form.skills.join(', ')}) load separately through the skills injector.`);
  }
  if (eff.metadata && metaSupported) {
    note.push(
      fetchMetadata
        ? 'The room topic goes on the user message as untrusted text, not here.'
        : 'Metadata is on but Fetch room metadata is off, so no topic is added.',
    );
  }

  const title = fixedSelector !== null ? `Edit room ${fixedSelector}` : 'Add room';
  const canDelete = entry !== null && fixedSelector !== null;
  const hintId = `${ids}-hint`;

  return (
    <Drawer
      open
      width={480}
      title={title}
      onClose={onClose}
      className="rooms-drawer"
      footer={
        <div className="rooms-drawer-footer">
          {canDelete ? (
            <>
              <Button
                danger
                disabled={busy}
                onClick={() => {
                  if (armed) {
                    setArmed(false);
                    onDelete();
                  } else {
                    setArmed(true);
                  }
                }}
              >
                {armed ? 'Confirm delete' : 'Delete'}
              </Button>
              {armed ? (
                <span className="rooms-delete-note">
                  Delete room {fixedSelector}? Removes its config lines and{' '}
                  {roomFileName(platform, fixedSelector)}.
                </span>
              ) : null}
            </>
          ) : null}
          <span className="rooms-grow" />
          <Button
            onClick={() => {
              setArmed(false);
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="primary"
            disabled={saveBlocked}
            onClick={() => onSave(selector, entryFromForm(form))}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="rooms-drawer-body">
        {error ? (
          <Alert
            type={error.kind === 'conflict' ? 'warning' : 'error'}
            showIcon
            message={error.message}
            {...(error.retry
              ? {
                  action: (
                    <Button size="small" onClick={error.retry} disabled={busy}>
                      Retry
                    </Button>
                  ),
                }
              : {})}
          />
        ) : null}

        <div className="rooms-field">
          <label htmlFor={`${ids}-id`}>{idLabel}</label>
          <Input
            id={`${ids}-id`}
            className="rooms-mono"
            value={form.roomId}
            readOnly={fixedSelector !== null}
            autoFocus={fixedSelector === null}
            autoComplete="off"
            spellCheck={false}
            status={idCheck.error ? 'error' : idCheck.warning ? 'warning' : undefined}
            aria-describedby={`${ids}-idmsg ${hintId}`}
            onChange={(e) => patch({ roomId: e.target.value })}
          />
          <div id={`${ids}-idmsg`}>
            {idCheck.error ? (
              <div className="rooms-msg rooms-msg-err" role="alert">
                {idCheck.error}
              </div>
            ) : idCheck.warning ? (
              <div className="rooms-msg rooms-msg-warn">{idCheck.warning}</div>
            ) : null}
          </div>
          <details className="rooms-hint" id={hintId}>
            <summary>How to find a {noun} ID</summary>
            <p>
              {ROOM_ID_HINTS[platform]} Or send{' '}
              <span className="rooms-mono">{channelCommand(platform)}</span> in the room. Its first
              line is the id.
            </p>
          </details>
        </div>

        {platform === 'telegram' && fixedSelector === null ? (
          <div className="rooms-field">
            <label htmlFor={`${ids}-topic`}>Topic ID</label>
            <Input
              id={`${ids}-topic`}
              className="rooms-mono"
              value={form.topicId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ topicId: e.target.value })}
            />
            <div className="rooms-small">
              Optional. Gives one forum topic its own rule, saved under the group.
            </div>
          </div>
        ) : null}

        {platform === 'discord' && fixedSelector === null ? (
          <div className="rooms-field">
            <label htmlFor={`${ids}-thread`}>Thread ID</label>
            <Input
              id={`${ids}-thread`}
              className="rooms-mono"
              value={form.threadId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ threadId: e.target.value })}
            />
            <div className="rooms-small">
              Optional. A thread's own id, saved as its own rule; it wins over the parent channel.
            </div>
          </div>
        ) : null}

        <div className="rooms-field">
          <label htmlFor={`${ids}-prompt`}>Room prompt</label>
          <Input.TextArea
            id={`${ids}-prompt`}
            className="rooms-mono"
            value={form.prompt}
            rows={7}
            status={counter.over ? 'error' : undefined}
            aria-describedby={`${ids}-ctr`}
            onChange={(e) => patch({ prompt: e.target.value })}
          />
          <div
            id={`${ids}-ctr`}
            className={`rooms-counter${counter.over ? ' rooms-counter-over' : ''}`}
          >
            <span>{counter.text}</span>
            <span>
              {counter.over
                ? `Over by ${counter.overBy.toLocaleString('en-US')}. Save is disabled.`
                : ''}
            </span>
          </div>
        </div>

        <div className="rooms-field">
          <span className="rooms-label" id={`${ids}-skills`}>
            Skills
          </span>
          <Select
            mode="tags"
            aria-labelledby={`${ids}-skills`}
            style={{ width: '100%' }}
            value={form.skills}
            options={(skillIds ?? []).map((s) => ({ value: s, label: s }))}
            tokenSeparators={[]}
            maxCount={8}
            placeholder="Pick or type a skill id"
            onChange={(v: string[]) => patch({ skills: v })}
          />
          <div className="rooms-small">
            Only skills the bound personality can load are applied. Free-text skill names are saved
            with a warning.
          </div>
          {unknownSkills.length > 0 ? (
            <div className="rooms-msg rooms-msg-warn">
              Not an installed skill: {unknownSkills.join(', ')}. Saved anyway; the gateway skips
              ids it cannot load.
            </div>
          ) : null}
        </div>

        <div className="rooms-two">
          <div className="rooms-field">
            <label htmlFor={`${ids}-mode`}>Mode</label>
            <select
              id={`${ids}-mode`}
              className="rooms-select"
              value={form.mode}
              onChange={(e) => patch({ mode: e.target.value })}
            >
              <option value="">not set</option>
              {modeOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="rooms-small">
              {form.mode !== ''
                ? (ROOM_MODE_DESCRIPTIONS[form.mode] ?? '')
                : 'The bot default applies.'}{' '}
              {platform === 'telegram' ? REGEX_MATCH_REFUSAL : ''}
            </div>
          </div>
          <div className="rooms-field">
            <label htmlFor={`${ids}-model`}>Model</label>
            <select
              id={`${ids}-model`}
              className="rooms-select"
              value={form.model.startsWith('alias:') && rawModel ? '' : form.model}
              onChange={(e) => patch({ model: e.target.value })}
            >
              <option value="">none (use the bot's model)</option>
              {aliasList.length > 0 ? (
                <optgroup label="Alias">
                  {aliasList.map((a) => (
                    <option key={a} value={`alias:${a}`}>
                      {modelAliases.includes(a) ? a : `${a} (not in registry)`}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="Tier">
                {TIERS.map((t) => (
                  <option key={t} value={`tier:${t}`}>
                    tier: {t}
                  </option>
                ))}
              </optgroup>
            </select>
            {rawModel ? (
              <Input
                className="rooms-mono"
                aria-label="Raw model id"
                placeholder="or a raw model id"
                style={{ marginTop: 6 }}
                value={form.model.startsWith('alias:') ? form.model.slice(6) : ''}
                onChange={(e) =>
                  patch({ model: e.target.value === '' ? '' : `alias:${e.target.value}` })
                }
              />
            ) : null}
            <div className="rooms-small">
              An alias or a tier, not both. An unknown alias is ignored at boot.
            </div>
          </div>
        </div>

        <div className="rooms-switches">
          <SwitchRow label="Silent" checked={eff.silent} onChange={(v) => patch({ silent: v })}>
            Reply NO_REPLY sends nothing in this room.
          </SwitchRow>
          <SwitchRow
            label="Identity"
            checked={eff.identity}
            onChange={(v) => patch({ identity: v })}
          >
            Tell the agent its own @handle here, so other mentions are not read as its own.
          </SwitchRow>
          <SwitchRow
            label="Metadata"
            checked={eff.metadata && metaSupported}
            disabled={!metaSupported}
            onChange={(v) => patch({ metadata: v })}
          >
            {metaSupported ? (
              <>
                Add the room's topic as untrusted context. Needs Fetch room metadata on for this
                platform. Platform switch now:{' '}
                <span className="rooms-mono">{fetchMetadata ? 'on' : 'off'}</span>.
              </>
            ) : (
              <>Add the room's topic as untrusted context: not available on {label} yet.</>
            )}
          </SwitchRow>
          <SwitchRow label="Inherit" checked={eff.inherit} onChange={(v) => patch({ inherit: v })}>
            Off: this room ignores the parent and wildcard for anything it leaves unset.
          </SwitchRow>
        </div>

        <div className="rooms-preview" aria-live="polite">
          <span className="rooms-micro">Preview</span>
          {previewInput === null ? (
            <div className="rooms-small">Enter a {noun} id to preview what the agent will see.</div>
          ) : preview.isError ? (
            <div className="rooms-msg rooms-msg-err" role="alert">
              {preview.error.message}
            </div>
          ) : preview.data ? (
            <>
              <dl>
                <dt>digest</dt>
                <dd>{preview.data.digest ?? 'none'}</dd>
                <dt>match chain</dt>
                <dd>{[...preview.data.match.layers, 'personality'].join(' → ')}</dd>
              </dl>
              <pre>{preview.data.block ?? '(no room block)'}</pre>
              {previewWarnings.map((w) => (
                <div key={w} className="rooms-msg rooms-msg-warn">
                  {w.endsWith('Saved anyway.') ? w : `${w} Saved anyway.`}
                </div>
              ))}
              <div className="rooms-small">{note.join(' ')}</div>
            </>
          ) : (
            <div className="rooms-small">Loading preview…</div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

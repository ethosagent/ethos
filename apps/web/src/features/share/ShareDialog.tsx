import type { Session } from '@ethosagent/web-contracts';
import { Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useShareCreate } from './api/mutations';
import { type ShareInclude, useSharePreview } from './api/queries';
import { SharePreview } from './SharePreview';
import {
  DEFAULT_EXPIRY,
  EXPIRY_OPTIONS,
  formatUtc,
  refusalCopy,
  relativeIn,
  turnsLabel,
} from './share-format';
import './share.css';

// Share a session as a read-only, expiring, redacted link (plan
// share-links.md §3 "Web UI", D4, D6, D7, D15). Mounted by its opener only
// while open, so closing unmounts it and drops the URL: the full link lives in
// the create mutation's result (`gcTime: 0`, api/mutations.ts) and nowhere else.
// Never persisted, never logged.

export const PREVIEW_DEBOUNCE_MS = 300;

// `incognito` is optional: the refusal header says "incognito" instead of
// "shared room" when the row data knows. The server refuses either way.
type ShareTarget = Pick<Session, 'id' | 'title' | 'personalityId'> & {
  incognito?: boolean | undefined;
};

export function ShareDialog({ session, onClose }: { session: ShareTarget; onClose: () => void }) {
  const [expiresIn, setExpiresIn] = useState(DEFAULT_EXPIRY);
  const [tools, setTools] = useState(false);
  const [pii, setPii] = useState(true);
  // What the preview was last fetched for; trails the toggles by the debounce.
  const [settled, setSettled] = useState<ShareInclude>({ includeToolNames: false, pii: true });
  const create = useShareCreate();
  // Mutation state lags a render behind a click; the ref closes that gap so two
  // synchronous clicks create one link.
  const inFlight = useRef(false);

  useEffect(() => {
    if (settled.includeToolNames === tools && settled.pii === pii) return;
    const t = setTimeout(() => setSettled({ includeToolNames: tools, pii }), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [tools, pii, settled]);

  const preview = useSharePreview(session.id, settled);
  const stale = settled.includeToolNames !== tools || settled.pii !== pii || preview.isFetching;

  const created = create.data?.ok ? create.data : null;
  const refusal =
    create.data && !create.data.ok
      ? create.data
      : preview.data && !preview.data.ok
        ? preview.data
        : null;
  const snapshot = preview.data?.ok ? preview.data.snapshot : null;
  const canCreate = snapshot !== null && !stale && !create.isPending && !created;
  const title = session.title ?? 'Untitled session';
  // Too large only because tool names are on: keep the form so the toggle can
  // be turned off. `isPlaceholderData` covers the refetch that follows that
  // toggle, so the form does not flicker into the refusal frame meanwhile.
  const toolsTooLarge =
    preview.data?.ok === false &&
    preview.data.reason === 'too_large' &&
    (settled.includeToolNames || preview.isPlaceholderData);
  const refusalTag = session.incognito ? 'incognito' : 'shared room';

  const submit = () => {
    if (!canCreate || inFlight.current) return;
    inFlight.current = true;
    create.mutate(
      {
        sessionId: session.id,
        includeToolNames: tools,
        pii,
        expiresIn,
      },
      {
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  return (
    <Modal
      open
      title={created ? 'Link created' : 'Share session'}
      footer={null}
      onCancel={onClose}
      // The URL appears once: a stray click or Esc must not throw it away.
      maskClosable={!created}
      keyboard={!created}
      width={520}
      className="share-dialog"
    >
      {created ? (
        <CreatedView
          title={title}
          created={created}
          includeToolNames={create.variables?.includeToolNames ?? false}
          pii={create.variables?.pii ?? true}
          onDone={onClose}
        />
      ) : refusal && !toolsTooLarge ? (
        <>
          <p className="share-ctx">
            {title}
            {session.personalityId ? <> &middot; {session.personalityId}</> : null}
            {refusal.reason === 'shared_session' ? <> &middot; {refusalTag}</> : null}
          </p>
          <div className="share-note share-note-err" role="alert">
            <span className="share-note-ic" aria-hidden="true">
              ✗
            </span>
            <span className="share-note-body">
              <b>{refusalCopy(refusal).title}</b> {refusalCopy(refusal).body}
            </span>
          </div>
          <div className="share-foot">
            <button type="button" className="share-btn" onClick={onClose}>
              Close
            </button>
            <button type="button" className="share-btn share-btn-primary" disabled>
              Create link
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="share-ctx">
            {title}
            {session.personalityId ? <> &middot; {session.personalityId}</> : null}
            {snapshot ? <> &middot; {turnsLabel(snapshot.turns.length)}</> : null}
          </p>

          <div className="share-field">
            <label className="share-l" htmlFor="share-expiry">
              Link expires after
            </label>
            <select
              id="share-expiry"
              className="share-select"
              value={expiresIn}
              onChange={(e) => {
                const next = EXPIRY_OPTIONS.find((o) => o.value === e.target.value);
                if (next) setExpiresIn(next.value);
              }}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="share-small">Expiry is required. A forgotten link must die.</div>
          </div>

          <ToggleRow
            id="share-tools"
            label="Include tool names"
            hint="Shows which tools ran and whether they failed. Never inputs or outputs."
            checked={tools}
            onChange={setTools}
          />
          <ToggleRow
            id="share-pii"
            label="Redact personal info"
            hint="Emails, phone numbers, cards, SSNs, IBANs. Secrets and keys are always redacted."
            checked={pii}
            onChange={setPii}
          />

          <div className="share-field">
            <div className="share-micro">Preview &middot; what the reader will see</div>
            {snapshot ? (
              <div aria-busy={stale}>
                <SharePreview snapshot={snapshot} />
              </div>
            ) : toolsTooLarge ? (
              <div className="share-note share-note-err" role="alert">
                <span className="share-note-ic" aria-hidden="true">
                  ✗
                </span>
                <span className="share-note-body">
                  <b>This conversation is too large to share.</b> Turn off <b>Include tool names</b>{' '}
                  and try again.
                </span>
              </div>
            ) : preview.isError ? (
              <div className="share-note share-note-err" role="alert">
                <span className="share-note-ic" aria-hidden="true">
                  ✗
                </span>
                <span className="share-note-body">
                  <b>Could not build the preview.</b> Close this dialog and try again.
                </span>
              </div>
            ) : (
              <div className="share-small" aria-busy="true">
                Building preview…
              </div>
            )}
            <div className="share-small share-gap">
              Redaction is pattern-based and can miss secrets it has no pattern for. Read the
              preview before you create the link. Chips appear only with <b>Include tool names</b>{' '}
              on.
            </div>
          </div>

          {create.isError ? (
            <div className="share-note share-note-err" role="alert">
              <span className="share-note-ic" aria-hidden="true">
                ✗
              </span>
              <span className="share-note-body">
                <b>Could not create the link.</b> Try again.
              </span>
            </div>
          ) : null}

          <div className="share-foot">
            <button type="button" className="share-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="share-btn share-btn-primary"
              disabled={!canCreate}
              onClick={submit}
            >
              Create link
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ToggleRow(props: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="share-field">
      <div className="share-trow">
        <span className="share-switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={props.checked}
            id={props.id}
            checked={props.checked}
            aria-describedby={`${props.id}-d`}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          <i />
        </span>
        <div className="share-tx">
          <label className="share-l share-l-flat" htmlFor={props.id}>
            {props.label}
          </label>
          <div className="share-small" id={`${props.id}-d`}>
            {props.hint}
          </div>
        </div>
      </div>
    </div>
  );
}

type Copy = 'idle' | 'copied' | 'failed';

function CreatedView(props: {
  title: string;
  created: { url: string; prefix: string; expiresAt: string; loopback: boolean };
  includeToolNames: boolean;
  pii: boolean;
  onDone: () => void;
}) {
  const { created } = props;
  const [copy, setCopy] = useState<Copy>('idle');

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(created.url);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  const includes = [
    props.includeToolNames ? 'user + assistant text, tool names' : 'user + assistant text',
    props.pii ? 'personal info redacted' : 'personal info not redacted',
  ].join(', ');

  return (
    <>
      <p className="share-ctx">{props.title}</p>
      <div className="share-urlrow">
        <textarea
          className="share-urlbox"
          aria-label="Share URL"
          readOnly
          rows={2}
          spellCheck={false}
          autoComplete="off"
          value={created.url}
        />
        {/* The URL shows once: put focus on its one next action. */}
        <button
          type="button"
          className="share-btn share-btn-primary"
          onClick={copyUrl}
          // biome-ignore lint/a11y/noAutofocus: the dialog's only next step, entered by the user's own click
          autoFocus
        >
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copy === 'failed' ? (
        <div className="share-small share-gap" role="status">
          Copy failed. Select the link and copy it by hand.
        </div>
      ) : null}
      {created.loopback ? (
        <>
          <div className="share-note share-note-warn" role="alert">
            <span className="share-note-ic" aria-hidden="true">
              !
            </span>
            <span className="share-note-body">
              <b>Opens only on this machine.</b> Set <code>webBaseUrl</code> and expose the port to
              share.
            </span>
          </div>
          <div className="share-note share-note-warn" role="status">
            <span className="share-note-ic" aria-hidden="true">
              !
            </span>
            <span className="share-note-body">
              <b>You won't see this link again.</b> Copy it now.
            </span>
          </div>
        </>
      ) : (
        <div className="share-note share-note-warn" role="status">
          <span className="share-note-ic" aria-hidden="true">
            !
          </span>
          <span className="share-note-body">
            <b>You won't see this link again.</b> Only a hash is stored. Copy it now. If you lose
            it, revoke it in Settings → Security & access and create a new one.
          </span>
        </div>
      )}
      <dl className="share-kv">
        <dt>Expires</dt>
        <dd>
          {formatUtc(created.expiresAt)} UTC ({relativeIn(created.expiresAt, Date.now())})
        </dd>
        <dt>Reference</dt>
        <dd>{created.prefix}</dd>
        <dt>Includes</dt>
        <dd>{includes}</dd>
      </dl>
      <div className="share-foot">
        <button type="button" className="share-btn" onClick={props.onDone}>
          Done
        </button>
      </div>
    </>
  );
}

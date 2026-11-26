import type { ShareLinkSummaryWire } from '@ethosagent/web-contracts';
import { App as AntApp } from 'antd';
import { useState } from 'react';
import { SectionHeading } from '../../pages/settings/components/section-heading';
import { SelfSaveMarker } from '../../pages/settings/components/self-save-marker';
import { useShareRevoke } from './api/mutations';
import { useShareList } from './api/queries';
import { formatUtc, minutesLeft, relativeIn } from './share-format';
import './share.css';

// Settings > Security & access > Shared links (plan share-links.md §3 "Web UI", mockup
// screen 3). Dense rows, not Cards (DESIGN.md "Cards earn existence"). The
// list never carries a URL or token: `shares.list` rows hold only the 8-char
// reference (packages/web-contracts/src/schema/shares.ts).

// config.yaml is a flat-key dialect (packages/config/src/parse.ts), so the
// snippet is `shareLinks.<field>: <value>`, not nested YAML.
const CONFIG_SNIPPET = `shareLinks.enabled: true
# shareLinks.excludePersonalities: ops, legal`;

const REVOKE_FAILURES = {
  not_found: 'That link is already gone.',
  ambiguous_prefix: 'More than one link matches that reference.',
  prefix_too_short: 'That reference is too short to match a link.',
} as const;

export function SharedLinksSection() {
  const { message } = AntApp.useApp();
  const list = useShareList();
  const revoke = useShareRevoke();
  const [confirming, setConfirming] = useState<string | null>(null);
  const now = Date.now();

  const doRevoke = (link: ShareLinkSummaryWire) => {
    revoke.mutate(link.id, {
      onSuccess: (result) => {
        setConfirming(null);
        if (result.ok) void message.success(`Revoked ${link.prefix}`);
        else void message.error(REVOKE_FAILURES[result.reason]);
      },
      onError: () => void message.error('Could not revoke the link'),
    });
  };

  const data = list.data;
  const status = !data ? (list.isError ? 'Unavailable' : '') : data.enabled ? '' : 'Off';

  return (
    <div className="share-section">
      <SectionHeading id="shared-links">shared links</SectionHeading>
      <SelfSaveMarker />
      {data?.enabled ? (
        <p className="share-small share-sec-sub">
          Active read-only snapshots. Revoking deletes the copy.
        </p>
      ) : status ? (
        <p className="share-small share-sec-sub">{status}</p>
      ) : null}

      {list.isError ? (
        <p className="share-empty" role="alert">
          Could not load shared links.
        </p>
      ) : !data ? (
        <p className="share-empty" aria-busy="true">
          Loading shared links…
        </p>
      ) : (
        <>
          {data.enabled ? null : <OffNote />}
          {data.links.length > 0 ? (
            <div>
              {data.links.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  now={now}
                  open={confirming === link.id}
                  revoking={revoke.isPending}
                  onAsk={() => setConfirming(link.id)}
                  onKeep={() => setConfirming(null)}
                  onRevoke={() => doRevoke(link)}
                />
              ))}
              <div className="share-small share-foot-note">
                Full URLs are never shown here. Reference ids match{' '}
                <code>ethos sessions share revoke &lt;ref&gt;</code>.
              </div>
            </div>
          ) : data.enabled ? (
            <p className="share-empty">
              No shared links. Open a session and choose <b>Share…</b>, or run{' '}
              <code>ethos sessions share &lt;id&gt;</code>.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function OffNote() {
  return (
    <div className="share-off">
      <div className="share-note share-note-info" role="status">
        <span className="share-note-ic" aria-hidden="true">
          i
        </span>
        <span className="share-note-body">
          <b>Share links are off.</b> Existing links return 404 while this is off. Turning it back
          on restores any that haven't expired. You can still revoke them below.
        </span>
      </div>
      <code className="share-cfg">{CONFIG_SNIPPET}</code>
      <div className="share-small">
        Set in <code>~/.ethos/config.yaml</code>. The Share… action is hidden while off.
      </div>
    </div>
  );
}

function LinkRow(props: {
  link: ShareLinkSummaryWire;
  now: number;
  open: boolean;
  revoking: boolean;
  onAsk: () => void;
  onKeep: () => void;
  onRevoke: () => void;
}) {
  const { link, now, open } = props;
  const soon = minutesLeft(link.expiresAt, now) < 60;
  return (
    <div className={`share-lrow${open ? ' share-lrow-confirm' : ''}`} data-link-id={link.id}>
      <div>
        <div className="share-lt">{link.title || 'Untitled session'}</div>
        <div className="share-lm">
          <span>
            ref <span className="share-mono">{link.prefix}</span>
          </span>
          <span className={soon ? 'share-expsoon' : undefined}>
            expires <span className="share-mono">{formatUtc(link.expiresAt)}</span>
            {soon ? ` (${relativeIn(link.expiresAt, now)})` : ''}
          </span>
          <span>
            views <span className="share-mono">{link.viewCount}</span>
          </span>
          <span>
            last viewed{' '}
            {link.lastViewedAt ? (
              <span className="share-mono">{formatUtc(link.lastViewedAt)}</span>
            ) : (
              <span className="share-dim">never</span>
            )}
          </span>
        </div>
      </div>
      {open ? (
        <div className="share-cf" role="alertdialog" aria-label="Confirm revoke">
          <span className="share-small share-cf-text">
            Revoke <span className="share-mono">{link.prefix}</span>? The copy is deleted and the
            URL returns 404 immediately. This can't be undone.
          </span>
          <button
            type="button"
            className="share-btn share-btn-sm share-btn-danger"
            disabled={props.revoking}
            onClick={props.onRevoke}
          >
            Revoke link
          </button>
          <button type="button" className="share-btn share-btn-sm" onClick={props.onKeep}>
            Keep
          </button>
        </div>
      ) : (
        <div className="share-act">
          <button
            type="button"
            className="share-btn share-btn-sm share-btn-danger"
            onClick={props.onAsk}
          >
            Revoke
          </button>
        </div>
      )}
    </div>
  );
}

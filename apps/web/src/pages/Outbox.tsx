import type { OutboxItemView } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from 'antd';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTelegramBots } from '../features/communications/api/queries';
import { type OutboxScope, outboxKeys } from '../features/outbox/api/keys';
import { getClientId } from '../lib/clientId';
import {
  botLabel,
  destinationLabel,
  formatWhen,
  OUTBOX_SECTIONS,
  type OutboxSection,
  platformLabel,
  revisionLine,
  sectionItems,
  statePill,
  terminalNote,
  timelineRows,
  waitingOnDispatcher,
} from '../lib/outbox';
import { errorCode } from '../lib/recipes';
import { rpc } from '../rpc';

// The Outbox — the personality approval queue's web surface (plan
// `trust-before-reach.md` Part 2, O-T10), rendered against the mockup the user
// signed off on 2026-09-12.
//
// One component, two scopes, the same arrangement `Cron` uses: with a
// `:personalityId` in the route it is the workspace pane
// (`/p/:personalityId/outbox`, and the same page under a team prefix); with
// only a `:teamId` it is the team pane and gathers every member's items.
//
// Not the `Card` primitive. "Cards earn existence" (DESIGN.md) reserves it for
// skill rows, cron rows and task tiles; these containers are raw primitives,
// the way `ClarifyCard` and `CallStrip` are, and the terminal states drop to
// dense rows because there the row is enough. No colored left border either —
// it is in the anti-slop table. State is a pill with an icon AND a word.
//
// What this pane will NOT do: pretend. It never claims a send can be recalled,
// never reports a queued post as sent, and where the mockup showed data the RPC
// does not carry (a chat's human title, which bots have a live adapter) the
// copy says what is actually known. See `lib/outbox.ts` for those calls.

/** Matches the dispatcher's own 5s poll closely enough that an approval seen
 *  here goes stale in seconds, without making an open tab a load generator. */
const OUTBOX_POLL_MS = 10_000;

/** What a stale approve means, in the words the user needs. Any other failure
 *  keeps its own message — a generic error here would hide the one case where
 *  re-reading the text is the whole point. */
const CONFLICT_MESSAGE =
  'Changed since you viewed it — nothing was approved. The text below has been re-read; check it before approving again.';

interface EditState {
  itemId: string;
  draft: string;
}

interface RejectState {
  itemId: string;
  reason: string;
}

export function Outbox() {
  const { personalityId, teamId } = useParams<{ personalityId?: string; teamId?: string }>();
  const queryClient = useQueryClient();
  const clientId = getClientId();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [reject, setReject] = useState<RejectState | null>(null);
  const [conflictItemId, setConflictItemId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A member's workspace inside a team carries BOTH params; the personality
  // wins, because the address is still that agent's pane.
  const scope: OutboxScope = personalityId ? { personalityId } : teamId ? { teamId } : {};
  const listKey = outboxKeys.list(scope);
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () => rpc.outbox.list(scope),
    refetchInterval: OUTBOX_POLL_MS,
  });

  // Sender labels. Telegram is the one platform that hands us a handle; every
  // other bot shows the botKey the dispatcher actually matches on.
  const botsQuery = useTelegramBots();
  const usernames = new Map<string, string>();
  for (const bot of botsQuery.data?.bots ?? []) {
    if (bot.username) usernames.set(bot.botKey, bot.username);
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });

  const onDecided = () => {
    setEdit(null);
    setReject(null);
    setConflictItemId(null);
    setFailure(null);
    void refresh();
  };

  const onFailed = (err: unknown, itemId: string) => {
    // A bound approve that lost its race is not an error message, it is a
    // re-read: mark the item and refetch so the operator sees the text that
    // actually stands now.
    if (errorCode(err) === 'CONFLICT') {
      setConflictItemId(itemId);
      setFailure(null);
      void refresh();
      return;
    }
    setFailure(err instanceof Error ? err.message : String(err));
  };

  const approveMut = useMutation({
    mutationFn: (item: OutboxItemView) =>
      rpc.outbox.approve({
        itemId: item.id,
        revision: item.revision,
        contentHash: item.contentHash,
        clientId,
      }),
    onSuccess: onDecided,
    onError: (err, item) => onFailed(err, item.id),
  });

  const editMut = useMutation({
    mutationFn: (input: { item: OutboxItemView; text: string }) =>
      rpc.outbox.edit({
        itemId: input.item.id,
        revision: input.item.revision,
        text: input.text,
        clientId,
      }),
    onSuccess: onDecided,
    onError: (err, input) => onFailed(err, input.item.id),
  });

  const rejectMut = useMutation({
    mutationFn: (input: { itemId: string; reason: string }) =>
      rpc.outbox.reject({ itemId: input.itemId, reason: input.reason, clientId }),
    onSuccess: onDecided,
    onError: (err, input) => onFailed(err, input.itemId),
  });

  const revokeMut = useMutation({
    mutationFn: (itemId: string) => rpc.outbox.revoke({ itemId, clientId }),
    onSuccess: onDecided,
    onError: (err, itemId) => onFailed(err, itemId),
  });

  const retryMut = useMutation({
    mutationFn: (itemId: string) => rpc.outbox.retry({ itemId, clientId }),
    onSuccess: onDecided,
    onError: (err, itemId) => onFailed(err, itemId),
  });

  const items = listQuery.data?.items ?? [];
  const waiting = waitingOnDispatcher(items);
  const busy =
    approveMut.isPending ||
    editMut.isPending ||
    rejectMut.isPending ||
    revokeMut.isPending ||
    retryMut.isPending;

  return (
    <div className="outbox-pane">
      <header className="page-header-row">
        <h1 className="page-h1">Outbox</h1>
        <span className="page-subtitle">
          {personalityId
            ? `${personalityId} · publications wait here until you approve the exact text`
            : teamId
              ? `every member of ${teamId} · publications wait here until you approve the exact text`
              : 'publications wait here until you approve the exact text'}
        </span>
      </header>

      <div className="outbox-body">
        {failure !== null && (
          <div className="outbox-notice outbox-notice-bad" role="alert">
            <span className="outbox-notice-ic" aria-hidden="true">
              ✗
            </span>
            <span>{failure}</span>
          </div>
        )}

        {waiting.length > 0 && (
          <div className="outbox-notice" data-testid="outbox-waiting-banner">
            <span className="outbox-notice-ic" aria-hidden="true">
              ⏳
            </span>
            <span>
              <b>
                {waiting.length} approved{' '}
                {waiting.length === 1 ? 'post is waiting' : 'posts are waiting'} to be sent.
              </b>{' '}
              The dispatcher claims an approved item within seconds of the sending bot's gateway
              starting, and nothing has claimed {waiting.length === 1 ? 'this one' : 'these'} — so
              that bot is most likely not running here. It goes out when the bot starts. Nothing is
              lost, and nothing sends from another bot.
            </span>
          </div>
        )}

        {listQuery.isLoading ? (
          <div className="outbox-empty">Loading…</div>
        ) : listQuery.isError ? (
          <div className="outbox-empty">
            Could not load the outbox:{' '}
            {listQuery.error instanceof Error ? listQuery.error.message : 'unknown error'}
          </div>
        ) : items.length === 0 ? (
          <div className="outbox-empty">
            Nothing queued. A personality with <code>outbound_policy.approve_before_send</code> puts
            every publication here instead of sending it, and its <code>send_message</code> answers
            "NOT sent".
          </div>
        ) : (
          OUTBOX_SECTIONS.map((section) => (
            <Section
              key={section.key}
              section={section}
              items={sectionItems(items, section)}
              usernames={usernames}
              clientId={clientId}
              busy={busy}
              edit={edit}
              reject={reject}
              conflictItemId={conflictItemId}
              onStartEdit={(item) => setEdit({ itemId: item.id, draft: item.text })}
              onChangeDraft={(draft) => setEdit((e) => (e ? { ...e, draft } : e))}
              onCancelEdit={() => setEdit(null)}
              onSaveEdit={(item, text) => editMut.mutate({ item, text })}
              onStartReject={(item) => setReject({ itemId: item.id, reason: '' })}
              onChangeReason={(reason) => setReject((r) => (r ? { ...r, reason } : r))}
              onCancelReject={() => setReject(null)}
              onReject={(itemId, reason) => rejectMut.mutate({ itemId, reason })}
              onApprove={(item) => approveMut.mutate(item)}
              onRevoke={(itemId) => revokeMut.mutate(itemId)}
              onRetry={(itemId) => retryMut.mutate(itemId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface SectionProps {
  section: OutboxSection;
  items: OutboxItemView[];
  usernames: ReadonlyMap<string, string>;
  clientId: string;
  busy: boolean;
  edit: EditState | null;
  reject: RejectState | null;
  conflictItemId: string | null;
  onStartEdit: (item: OutboxItemView) => void;
  onChangeDraft: (draft: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (item: OutboxItemView, text: string) => void;
  onStartReject: (item: OutboxItemView) => void;
  onChangeReason: (reason: string) => void;
  onCancelReject: () => void;
  onReject: (itemId: string, reason: string) => void;
  onApprove: (item: OutboxItemView) => void;
  onRevoke: (itemId: string) => void;
  onRetry: (itemId: string) => void;
}

function Section(props: SectionProps) {
  const { section, items } = props;
  if (items.length === 0) return null;
  return (
    <section className="outbox-sec" data-testid={`outbox-section-${section.key}`}>
      <div className="outbox-sec-label">
        {section.label} <span className="outbox-sec-count">{items.length}</span>
      </div>
      {section.key === 'terminal' ? (
        <div className="outbox-dense">
          {items.map((item) => (
            <TerminalRow key={item.id} item={item} busy={props.busy} onRetry={props.onRetry} />
          ))}
        </div>
      ) : (
        items.map((item) => <Item key={item.id} {...props} item={item} />)
      )}
    </section>
  );
}

function Item(props: SectionProps & { item: OutboxItemView }) {
  const { item, usernames, clientId, busy, edit, reject, conflictItemId, section } = props;
  const sender = botLabel(item.botKey, usernames);
  const pill = statePill(item);
  const editing = edit?.itemId === item.id ? edit : null;
  const dirty = editing !== null && editing.draft !== item.text;
  const rejecting = reject?.itemId === item.id ? reject : null;
  const decidable = item.state === 'awaiting_approval';
  // Revocable until the dispatcher claims the row; after the claim the
  // conditional UPDATE has already settled it and the answer is "sent".
  const revocable = item.state === 'approved' && item.claimedAt === null;

  return (
    <article
      className={`outbox-item${section.key === 'needs_you' ? ' outbox-item-attn' : ''}`}
      data-testid="outbox-item"
      data-item-id={item.id}
      data-state={item.state}
    >
      <div className="outbox-row outbox-row-between">
        <div className="outbox-row">
          <span className="outbox-chip">
            <span className="outbox-chip-dot" aria-hidden="true" />
            {destinationLabel(item)}
          </span>
          <span className="outbox-chip outbox-chip-sender" title={item.botKey}>
            <span className="outbox-chip-dot" aria-hidden="true" />
            {sender}
          </span>
        </div>
        <span className={`outbox-pill outbox-pill-${pill.tone}`}>
          <span className="outbox-pill-ic" aria-hidden="true">
            {pill.icon}
          </span>
          {pill.word}
        </span>
      </div>

      <div className="outbox-meta">
        Drafted by <b>{item.personalityId}</b> {formatWhen(item.createdAt)} ·{' '}
        <span className="outbox-rev">{revisionLine(item)}</span>
      </div>

      {conflictItemId === item.id && (
        <div className="outbox-conflict" role="alert" data-testid="outbox-conflict">
          {CONFLICT_MESSAGE}
        </div>
      )}

      {editing ? (
        <>
          <textarea
            className="outbox-textarea"
            aria-label="Message text"
            data-testid="outbox-edit-text"
            value={editing.draft}
            onChange={(e) => props.onChangeDraft(e.target.value)}
          />
          <div className="outbox-actions">
            <Button
              size="small"
              disabled={busy || !dirty || editing.draft.length === 0}
              data-testid="outbox-save-edit"
              onClick={() => props.onSaveEdit(item, editing.draft)}
            >
              Save revision {item.revision + 1}
            </Button>
            <Button size="small" onClick={props.onCancelEdit}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <pre className="outbox-preview" data-testid="outbox-preview">
          {item.text}
        </pre>
      )}

      {item.review && (
        <div className="outbox-receipt">
          <span className="outbox-receipt-ic" aria-hidden="true">
            {item.review.verdict === 'fail' ? '✗' : item.review.verdict === 'pass' ? '✓' : '⏳'}
          </span>
          <div>
            <span className="outbox-receipt-who">{item.approverPersonality ?? 'reviewer'}</span>{' '}
            <span className={`outbox-verdict outbox-verdict-${item.review.verdict}`}>
              {item.review.verdict.toUpperCase()}
            </span>{' '}
            — {item.review.reasons}
            <div className="outbox-meta">
              reviewed revision {item.review.revision}
              {item.review.revision < item.revision ? ' — your edit has not been re-reviewed' : ''}
            </div>
          </div>
        </div>
      )}

      {section.key === 'approved' && (
        <div className="outbox-tl">
          {timelineRows(item, { clientId, botLabel: sender }).map((row) => (
            <div
              key={row.key}
              className={`outbox-tl-row ${row.done ? 'outbox-tl-done' : 'outbox-tl-pend'}`}
            >
              <span className="outbox-tl-ic" aria-hidden="true">
                {row.icon}
              </span>
              <span>{row.text}</span>
              <span className="outbox-tl-t">{row.time}</span>
            </div>
          ))}
        </div>
      )}

      {item.state === 'sent' && (
        <div className="outbox-notice outbox-notice-flat" data-testid="outbox-cannot-unsend">
          <span className="outbox-notice-ic" aria-hidden="true">
            →
          </span>
          <span>Ethos cannot unsend this — delete it on {platformLabel(item.platform)}.</span>
        </div>
      )}

      {item.state === 'unconfirmed' && (
        <div className="outbox-notice" data-testid="outbox-unconfirmed">
          <span className="outbox-notice-ic" aria-hidden="true">
            ⏳
          </span>
          <span>
            Handed to the delivery ledger; {platformLabel(item.platform)} did not confirm. The
            ledger owns the retry from here — the outbox will not send it again.
            {item.obligationId !== null && (
              <>
                {' '}
                Obligation <span className="outbox-mono">{item.obligationId}</span>.
              </>
            )}
          </span>
        </div>
      )}

      {rejecting ? (
        <>
          <textarea
            className="outbox-textarea outbox-textarea-reason"
            aria-label="Rejection reason"
            data-testid="outbox-reject-reason"
            placeholder="Why — the agent sees this, and so does the audit trail"
            value={rejecting.reason}
            onChange={(e) => props.onChangeReason(e.target.value)}
          />
          <div className="outbox-actions">
            <Button
              size="small"
              danger
              disabled={busy || rejecting.reason.trim().length === 0}
              data-testid="outbox-confirm-reject"
              onClick={() => props.onReject(item.id, rejecting.reason.trim())}
            >
              Reject
            </Button>
            <Button size="small" onClick={props.onCancelReject}>
              Cancel
            </Button>
          </div>
        </>
      ) : decidable || revocable ? (
        <div className="outbox-actions">
          {decidable && (
            <>
              <Button
                size="small"
                type="primary"
                // You cannot approve text you are midway through changing: the
                // approval binds `{revision, contentHash}`, and the bytes on
                // screen are no longer those bytes.
                disabled={busy || dirty}
                data-testid="outbox-approve"
                onClick={() => props.onApprove(item)}
              >
                Approve &amp; send
              </Button>
              {!editing && (
                <Button
                  size="small"
                  data-testid="outbox-edit"
                  onClick={() => props.onStartEdit(item)}
                >
                  Edit
                </Button>
              )}
              <Button size="small" danger onClick={() => props.onStartReject(item)}>
                Reject…
              </Button>
            </>
          )}
          {revocable && (
            <Button
              size="small"
              danger
              disabled={busy}
              data-testid="outbox-revoke"
              onClick={() => props.onRevoke(item.id)}
            >
              Revoke
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
}

function TerminalRow(props: {
  item: OutboxItemView;
  busy: boolean;
  onRetry: (itemId: string) => void;
}) {
  const { item } = props;
  const pill = statePill(item);
  return (
    <div className="outbox-drow" data-testid="outbox-terminal-row" data-state={item.state}>
      <span className={`outbox-pill outbox-pill-${pill.tone}`}>
        <span className="outbox-pill-ic" aria-hidden="true">
          {pill.icon}
        </span>
        {pill.word}
      </span>
      <span className="outbox-drow-txt">{item.text}</span>
      <span className="outbox-meta outbox-mono">
        {terminalNote(item)} · {formatWhen(item.updatedAt)}
      </span>
      {item.state === 'failed' && (
        <Button
          size="small"
          disabled={props.busy}
          data-testid="outbox-retry"
          onClick={() => props.onRetry(item.id)}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

import type { AmendmentRecordView, AmendmentReviewView } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { learningKeys } from '../features/learning/api/keys';
import {
  AMENDMENT_OPEN,
  AMENDMENT_STATUS_WORDS,
  cliCommands,
  DIRECTION_PILLS,
  diffKind,
  FLAG_TEXT,
  opsLabel,
  wantsAvatarUpload,
} from '../lib/amendments';
import { formatAge, formatStamp } from '../lib/learning';
import { rpc } from '../rpc';
import { PersonalityMark } from './ui/PersonalityMark';

// "Definition changes" — the Learning page's READ-ONLY view of personality
// self-amendments (plan personality-memory-boundary-and-self-amendment G2,
// D30). A personality that lists `propose_self_amendment` can ask for a tool,
// or — at the end of its birth ritual (plan personality-presence-and-initiative
// §1) — for the name, vibe, emoji and avatar its owner chose; the request waits
// here with the permission diff (toolset only), the file diff, its flags and
// history. There is deliberately NO apply button in v1: the page
// names the terminal command, and the CLI holds the gate (a TTY, the
// personality id typed back, and the ETHOS_TOOL_PROCESS tripwire — D32).
//
// Built from the Learning page's own primitives (rows, chips, pills with an
// icon AND a word, the diff view) so it reads as part of that page, not a
// card bolted on. Personality-written text (rationale, evidence) is rendered
// as text: React escapes it, and it never becomes markup.

const POLL_MS = 30_000;

export function DefinitionChanges() {
  const [openId, setOpenId] = useState<string | null>(null);
  const listQuery = useQuery({
    queryKey: learningKeys.amendments(AMENDMENT_OPEN),
    queryFn: () => rpc.amendments.list({ statuses: [...AMENDMENT_OPEN] }),
    refetchInterval: POLL_MS,
    retry: false,
  });
  const amendments = listQuery.data?.amendments ?? [];
  // Nothing waiting (or no agent in this process yet): the section is absent,
  // so the page stays about the learning queue.
  if (amendments.length === 0) return null;

  return (
    <section className="learning-group" data-testid="definition-changes">
      <div className="learning-group-label">
        Definition changes <span className="learning-group-count">{amendments.length}</span>
      </div>
      <div className="learning-sub">
        A personality asked to change its own toolset or identity. Review it here; apply or decline
        it from a terminal.
      </div>
      {amendments.map((a) => (
        <div key={a.id} className="learning-panel">
          <AmendmentRow
            amendment={a}
            open={a.id === openId}
            onToggle={() => setOpenId(a.id === openId ? null : a.id)}
          />
          {a.id === openId ? <AmendmentReviewPanel amendmentId={a.id} /> : null}
        </div>
      ))}
    </section>
  );
}

function AmendmentRow({
  amendment,
  open,
  onToggle,
}: {
  amendment: AmendmentRecordView;
  open: boolean;
  onToggle: () => void;
}) {
  const stale = amendment.status === 'stale';
  return (
    <button
      type="button"
      className={`learning-row${open ? ' learning-row-sel' : ''}`}
      data-testid="amendment-row"
      data-amendment-id={amendment.id}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="learning-row-top">
        <PersonalityMark personalityId={amendment.personalityId} size={14} />
        <span className="learning-row-name learning-mono">{opsLabel(amendment)}</span>
      </span>
      <span className="learning-row-bot">
        <span className="learning-chip">
          {amendment.target === 'identity' ? 'config.yaml' : 'toolset.yaml'}
        </span>
        <span className={`learning-pill learning-pill-${stale ? 'muted' : 'wait'}`}>
          <span className="learning-pill-ic" aria-hidden="true">
            {stale ? '·' : '⏳'}
          </span>
          {AMENDMENT_STATUS_WORDS[amendment.status]}
        </span>
        <span className="learning-mono">{amendment.personalityId}</span>
        <span>{formatAge(amendment.createdAt)}</span>
      </span>
    </button>
  );
}

function AmendmentReviewPanel({ amendmentId }: { amendmentId: string }) {
  const query = useQuery({
    queryKey: learningKeys.amendment(amendmentId),
    queryFn: () => rpc.amendments.get({ amendmentId }),
    retry: false,
  });
  if (query.isLoading) return <div className="learning-sub">Loading…</div>;
  if (query.isError || !query.data) {
    return (
      <div className="learning-sub" role="alert">
        Could not load this request:{' '}
        {query.error instanceof Error ? query.error.message : 'unknown error'}
      </div>
    );
  }
  return <ReviewBody review={query.data.review} />;
}

function ReviewBody({ review }: { review: AmendmentReviewView }) {
  const { record } = review;
  const changes = review.permissionDiff?.changes ?? [];
  const commands = cliCommands(review);
  return (
    <div className="learning-detail" data-testid="amendment-review">
      {review.flags.includes('local-terminal') ? (
        <div className="learning-notice" role="note" data-testid="amendment-local-terminal">
          <span className="learning-notice-ic" aria-hidden="true">
            !
          </span>
          <span>
            <b>
              This personality can already edit its own definition — this review is not a boundary
              for it.
            </b>{' '}
            It holds a shell tool under local execution, so it can change {review.file} or run the
            CLI itself.
          </span>
        </div>
      ) : null}
      {review.stale ? (
        <div className="learning-notice" role="note">
          <span className="learning-notice-ic" aria-hidden="true">
            ✗
          </span>
          <span>
            {review.file} changed since this was filed, so it can no longer be applied. Decline it;
            the personality can ask again.
          </span>
        </div>
      ) : null}
      {review.opsProblem ? <div className="learning-sub">{review.opsProblem}</div> : null}

      <section className="learning-panel">
        <h2>Permission diff</h2>
        {record.target === 'identity' ? (
          <div className="learning-sub">
            None — an identity change sets how the personality presents itself and grants nothing.
          </div>
        ) : changes.length === 0 ? (
          <div className="learning-sub">No permission row changes.</div>
        ) : (
          <div className="learning-tl" data-testid="amendment-permission-diff">
            {changes.map((change) => {
              const pill = DIRECTION_PILLS[change.direction];
              return (
                <div
                  key={`${change.section}:${change.detail}`}
                  className="learning-tl-row"
                  data-direction={change.direction}
                >
                  <span className={`learning-pill learning-pill-${pill.tone}`}>
                    <span className="learning-pill-ic" aria-hidden="true">
                      {pill.icon}
                    </span>
                    {pill.word}
                  </span>
                  <span>
                    {change.section}: <span className="learning-mono">{change.detail}</span>
                  </span>
                  {change.flag ? (
                    <span className="learning-pill learning-pill-bad" data-flag={change.flag}>
                      <span className="learning-pill-ic" aria-hidden="true">
                        !
                      </span>
                      {change.flag}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {record.target === 'identity' ? null : (
          <div className="learning-sub">{review.notCompared}</div>
        )}
      </section>

      <section className="learning-panel">
        <h2>{review.file}</h2>
        <div className="learning-diff" data-testid="amendment-diff">
          {review.textDiff.map((line, i) => {
            const kind = diffKind(line);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id; order is fixed
                key={i}
                className={`learning-diff-line learning-diff-${kind}`}
                data-kind={kind}
              >
                {`${line.slice(0, 1)} ${line.slice(1)}`}
              </div>
            );
          })}
        </div>
      </section>

      {review.flags.length > 0 ? (
        <section className="learning-panel">
          <h2>Flags</h2>
          {review.flags.map((flag) => (
            <div key={flag} className="learning-sub">
              <span className="learning-mono">{flag}</span> — {FLAG_TEXT[flag]}
            </div>
          ))}
        </section>
      ) : null}

      <section className="learning-panel">
        <h2>Why it asked</h2>
        <div className="learning-sub">Written by the personality — read it as a claim.</div>
        <pre className="learning-digest">{record.rationale}</pre>
        {record.evidence.map((e) => (
          <div key={e.toolCallId} className="learning-sub">
            <span className="learning-mono">{e.toolName}</span> was refused:{' '}
            <span className="learning-mono">{e.excerpt}</span>
          </div>
        ))}
        <div className="learning-sub">
          Filed {formatAge(record.createdAt)} from{' '}
          <span className="learning-mono">{record.provenance.sessionKey}</span> · execution{' '}
          {record.provenance.executionPosture}
        </div>
      </section>

      <section className="learning-panel">
        <h2>History</h2>
        <div className="learning-tl">
          {record.history.map((h, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: history is append-only; order is stable
              key={i}
              className="learning-tl-row"
            >
              <span className="learning-tl-t">{formatStamp(h.at)}</span>
              <span>
                {h.action} ({h.actor}
                {h.decidedBy ? ` · ${h.decidedBy}` : ''}){h.reason ? ` — ${h.reason}` : ''}
              </span>
            </div>
          ))}
        </div>
      </section>

      {commands.length > 0 ? (
        <section className="learning-panel" data-testid="amendment-cli">
          <h2>Decide in a terminal</h2>
          <div className="learning-sub">
            The web view is read-only. The CLI shows this same review and asks you to type the
            personality id before it writes anything.
          </div>
          {commands.map((c) => (
            <div key={c.command} className="learning-sub">
              {c.label}: <code className="learning-mono">{c.command}</code>
            </div>
          ))}
          {wantsAvatarUpload(record) ? (
            <div className="learning-sub" data-testid="amendment-avatar-upload">
              The owner chose to upload an avatar: after applying, upload it from{' '}
              <span className="learning-mono">{record.personalityId}</span>'s page under
              Personalities. Until then it shows the generated mark.
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

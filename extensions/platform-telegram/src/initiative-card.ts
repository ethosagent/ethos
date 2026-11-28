// Initiative digest and brief cards: pure text + inline-keyboard builders. The adapter sends them
// with `sendInlineKeyboard`; the tap arrives as a `callback_query` whose data is the compact
// action id `init:<verb>:<target>` (`initiativeActionId`, @ethosagent/types). A target that would
// push the id past Telegram's 64-byte `callback_data` limit gets no buttons (the card says so and
// names the CLI command), never a truncated id that could point at another row.

import {
  CALLBACK_DATA_MAX_BYTES,
  type DigestBrief,
  type InitiativeActionVerb,
  type InitiativeDigest,
  initiativeActionId,
} from '@ethosagent/types';
import type { InlineButton } from './index';

/** An owner tap on a digest or brief button, surfaced to the host's initiative wiring. */
export interface InitiativeActionEvent {
  verb: InitiativeActionVerb;
  /** A ledger id (`EXP-0001` or an initiative id), parsed by `parseInitiativeAction`. */
  target: string;
  /** The tapping Telegram user. The wiring compares it to `channel_filter.telegram.ownerUserId`; the adapter enforces nothing. */
  userId: string | undefined;
  chatId: string;
  messageId: string;
  /** Dismiss the spinner with an optional toast. If the handler does not call it, the adapter does. */
  answer: (text?: string) => Promise<void>;
  /** A follow-up message in the same chat (the brief as Markdown, the chat hand-off). */
  /** Resolves true when the message was sent, false when Telegram refused it (e.g. over 4096 chars). */
  reply: (text: string) => Promise<boolean>;
}

export interface InitiativeCard {
  text: string;
  rows: InlineButton[][];
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const LINE_MAX = 280;
const MAX_ITEMS = 8;
const cut = (s: string): string => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX)}…` : s);

function btn(label: string, verb: InitiativeActionVerb, target: string): InlineButton | null {
  const data = initiativeActionId(verb, target);
  return Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_MAX_BYTES ? { label, data } : null;
}

function row(...buttons: Array<InlineButton | null>): InlineButton[] {
  return buttons.filter((b): b is InlineButton => b !== null);
}

function briefLines(b: DigestBrief): string[] {
  return [
    `${b.explorationId}: ${cut(b.question)}${b.partial ? ' (partial)' : ''}`,
    ...(b.found.length
      ? ['Found:', ...b.found.slice(0, MAX_ITEMS).map((f) => `- ${f.id}: ${cut(f.claim)}`)]
      : []),
    ...(b.stillUnknown.length
      ? ['Still unknown:', ...b.stillUnknown.slice(0, MAX_ITEMS).map((u) => `- ${cut(u)}`)]
      : []),
    ...(b.options.length
      ? ['Options:', ...b.options.slice(0, MAX_ITEMS).map((o) => `- ${cut(o)}`)]
      : []),
    ...(b.effort ? [`Effort: ${cut(b.effort)}`] : []),
    ...(b.risk ? [`Risk: ${cut(b.risk)}`] : []),
    ...(b.recommendation ? [`Recommendation: ${cut(b.recommendation)}`] : []),
  ];
}

const BRIEF_BUTTONS = 4;

function briefRows(b: DigestBrief): InlineButton[][] {
  const adopt = b.recommendedOption ? `Adopt ${b.recommendedOption.slice(0, 20)}` : 'Adopt';
  const dig = b.digDeeperUsd === null ? 'Dig deeper' : `Dig deeper (${usd(b.digDeeperUsd)})`;
  return [
    row(btn(adopt, 'adopt', b.explorationId), btn(dig, 'dig_deeper', b.explorationId)),
    row(btn('Park', 'park', b.explorationId), btn('Copy as Markdown', 'copy_md', b.explorationId)),
  ].filter((r) => r.length > 0);
}

/** The CLI fallback line when any of a brief's buttons did not fit in `callback_data`. */
function briefFallback(b: DigestBrief, rows: InlineButton[][]): string[] {
  return rows.flat().length < BRIEF_BUTTONS
    ? [`Use: ethos initiatives adopt ${b.explorationId} (or dig-deeper, park, export)`]
    : [];
}

/** One brief as its own card. */
export function briefCard(b: DigestBrief): InitiativeCard {
  const rows = briefRows(b);
  return { text: [...briefLines(b), ...briefFallback(b, rows)].join('\n'), rows };
}

/**
 * The digest as one message. Telegram caps a message at 4096 characters; the caller sends one card
 * per brief when the whole does not fit (`text.length`), which is why `briefCard` is exported.
 */
export function digestCard(d: InitiativeDigest): InitiativeCard {
  const lines: string[] = [`Initiatives: ${d.personalityId}`];
  const rows: InlineButton[][] = [];
  if (d.ownWork.windows > 0) {
    lines.push(
      '',
      `Did on its own: ${d.ownWork.windows} windows, ${usd(d.ownWork.spentUsd)} spent.`,
      ...d.ownWork.explorations
        .slice(0, MAX_ITEMS)
        .map((e) => `- ${e.id}${e.auto ? ' (started automatically)' : ''}: ${cut(e.question)}`),
    );
  }
  if (d.needsYes.length) {
    lines.push('', 'Needs a yes:');
    for (const p of d.needsYes.slice(0, MAX_ITEMS)) {
      const r = row(
        btn(`Approve ${p.explorationId}`, 'approve', p.explorationId),
        btn('Edit scope', 'edit', p.explorationId),
        btn('Snooze 1w', 'snooze', p.explorationId),
        btn('Never', 'reject', p.explorationId),
      );
      lines.push(
        `- ${p.explorationId}: ${cut(p.question)}${p.estimateUsd === null ? '' : ` (about ${usd(p.estimateUsd)})`}${r.length === 0 ? `. Use: ethos initiatives approve ${p.explorationId}` : ''}`,
      );
      if (r.length) rows.push(r);
    }
  }
  if (d.agentInitiatives.length) {
    lines.push('', 'Started by the agent:');
    for (const i of d.agentInitiatives.slice(0, MAX_ITEMS)) {
      const r = row(
        btn(`Keep ${i.id}`, 'keep', i.id),
        btn('Make it mine', 'make_mine', i.id),
        btn('Stop', 'stop', i.id),
      );
      lines.push(`- ${i.id}${r.length === 0 ? `. Use: ethos initiatives keep ${i.id}` : ''}`);
      if (r.length) rows.push(r);
    }
  }
  if (d.briefs.length) {
    lines.push('', 'Briefs ready:');
    for (const b of d.briefs.slice(0, MAX_ITEMS)) {
      const r = briefRows(b);
      lines.push(...briefLines(b), ...briefFallback(b, r), '');
      rows.push(...r);
    }
  }
  if (d.questions.length) {
    lines.push(
      '',
      'Open questions:',
      ...d.questions.slice(0, MAX_ITEMS).map((q) => `- ${q.id}: ${cut(q.text)}`),
    );
  }
  if (d.suggestions.length) {
    lines.push(
      '',
      'Agent suggestions:',
      ...d.suggestions.slice(0, MAX_ITEMS).map((s) => `- ${s.draftId}: ${cut(s.why)}`),
    );
  }
  return { text: lines.join('\n').trimEnd(), rows };
}

// Block Kit builders for the initiative digest and options brief. Pure functions, no Slack client.
// Every button's `action_id` and `value` is the compact action id `init:<verb>:<target>`
// (`initiativeActionId`, @ethosagent/types): a ledger id, never text a model wrote. The adapter
// parses a tap with `parseInitiativeAction` and hands it to the wiring, which owns the owner check
// (`isUserAuthorized`, ../authz) and the decision write.

import {
  type DigestBrief,
  type InitiativeActionVerb,
  type InitiativeDigest,
  initiativeActionId,
} from '@ethosagent/types';
import {
  context,
  divider,
  escapeMrkdwn,
  header,
  type SlackBlock,
  section,
  truncate,
} from './shared';

/** Slack allows 50 blocks per message; leave room for the header and footer. */
const MAX_ITEMS = 8;
const LINE_MAX = 280;

function button(
  label: string,
  verb: InitiativeActionVerb,
  target: string,
  style?: 'primary' | 'danger',
) {
  const id = initiativeActionId(verb, target);
  return {
    type: 'button',
    action_id: id,
    text: { type: 'plain_text', text: label, emoji: true },
    value: id,
    ...(style ? { style } : {}),
  };
}

function actions(...elements: ReturnType<typeof button>[]): SlackBlock {
  return { type: 'actions', elements };
}

const line = (text: string): string => escapeMrkdwn(truncate(text, LINE_MAX));
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** One brief: found (with finding ids), still unknown, options, effort and risk, recommendation, and its buttons. */
export function briefBlocks(b: DigestBrief): SlackBlock[] {
  const lines = [`*${line(b.question)}*${b.partial ? ' _(partial)_' : ''}`];
  if (b.found.length) {
    lines.push(
      '*Found*',
      ...b.found.slice(0, MAX_ITEMS).map((f) => `• \`${f.id}\` ${line(f.claim)}`),
    );
  }
  if (b.stillUnknown.length) {
    lines.push('*Still unknown*', ...b.stillUnknown.slice(0, MAX_ITEMS).map((u) => `• ${line(u)}`));
  }
  if (b.options.length) {
    lines.push('*Options*', ...b.options.slice(0, MAX_ITEMS).map((o) => `• ${line(o)}`));
  }
  if (b.effort) lines.push(`*Effort:* ${line(b.effort)}`);
  if (b.risk) lines.push(`*Risk:* ${line(b.risk)}`);
  if (b.recommendation) lines.push(`*Recommendation:* ${line(b.recommendation)}`);
  const adopt = b.recommendedOption ? `Adopt ${truncate(b.recommendedOption, 24)}` : 'Adopt';
  return [
    section(truncate(lines.join('\n'), 2900)),
    actions(
      button(adopt, 'adopt', b.explorationId, 'primary'),
      button(
        b.digDeeperUsd === null ? 'Dig deeper' : `Dig deeper (${usd(b.digDeeperUsd)})`,
        'dig_deeper',
        b.explorationId,
      ),
      button('Park', 'park', b.explorationId),
      button('Copy as Markdown', 'copy_md', b.explorationId),
    ),
  ];
}

/** The whole digest. Empty sections are left out. */
export function digestBlocks(d: InitiativeDigest): SlackBlock[] {
  const blocks: SlackBlock[] = [header(`Initiatives: ${truncate(d.personalityId, 60)}`)];
  if (d.ownWork.windows > 0) {
    blocks.push(
      section(
        `*Did on its own*\n${d.ownWork.windows} windows, ${usd(d.ownWork.spentUsd)} spent.\n${d.ownWork.explorations
          .slice(0, MAX_ITEMS)
          .map(
            (e) => `• \`${e.id}\` ${line(e.question)}${e.auto ? ' _(started automatically)_' : ''}`,
          )
          .join('\n')}`.trimEnd(),
      ),
    );
  }
  if (d.needsYes.length) {
    blocks.push(divider(), section('*Needs a yes*'));
    for (const p of d.needsYes.slice(0, MAX_ITEMS)) {
      blocks.push(
        section(
          `\`${p.explorationId}\` ${line(p.question)}${p.estimateUsd === null ? '' : ` (about ${usd(p.estimateUsd)})`}`,
        ),
        actions(
          button('Approve', 'approve', p.explorationId, 'primary'),
          button('Edit scope', 'edit', p.explorationId),
          button('Snooze 1w', 'snooze', p.explorationId),
          button('Never', 'reject', p.explorationId, 'danger'),
        ),
      );
    }
  }
  if (d.agentInitiatives.length) {
    blocks.push(divider(), section('*Started by the agent*'));
    for (const i of d.agentInitiatives.slice(0, MAX_ITEMS)) {
      blocks.push(
        section(`\`${escapeMrkdwn(i.id)}\``),
        actions(
          button('Keep', 'keep', i.id, 'primary'),
          button('Make it mine', 'make_mine', i.id),
          button('Stop', 'stop', i.id, 'danger'),
        ),
      );
    }
  }
  if (d.briefs.length) {
    blocks.push(divider(), section('*Briefs ready*'));
    for (const b of d.briefs.slice(0, MAX_ITEMS)) blocks.push(...briefBlocks(b));
  }
  if (d.questions.length) {
    blocks.push(
      divider(),
      section(
        `*Open questions*\n${d.questions
          .slice(0, MAX_ITEMS)
          .map((q) => `• \`${q.id}\` ${line(q.text)}`)
          .join('\n')}`,
      ),
      context(['Answer in chat with the agent.']),
    );
  }
  if (d.suggestions.length) {
    blocks.push(
      divider(),
      section(
        `*Agent suggestions*\n${d.suggestions
          .slice(0, MAX_ITEMS)
          .map((s) => `• \`${s.draftId}\` ${line(s.why)}`)
          .join('\n')}`,
      ),
      context(['Turn on self-start for this personality, or tell the agent to define one.']),
    );
  }
  return blocks;
}

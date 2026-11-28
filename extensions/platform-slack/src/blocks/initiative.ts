// Block Kit builders for the initiative digest and options brief. Pure functions, no Slack client.
// Every button's `action_id` and `value` is the compact action id `init:<verb>:<target>`
// (`initiativeActionId`, @ethosagent/types): a ledger id, never text a model wrote. The adapter
// parses a tap (`SlackAdapter.onInitiativeAction`, ../interactions/initiative) and the app's
// `createInitiativeTapHandler` (apps/ethos/src/lib/initiative-wiring.ts) refuses anyone but
// `channel_filter.slack.ownerUserId` and writes the decision through `decideInitiative`; pinned by
// apps/ethos/src/__tests__/initiative-wiring.test.ts ('non-owner tap refused'). Not `isUserAuthorized`
// (../authz): that is the slash-command allowlist, which admits more people than the owner.

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

/** Slack's section text cap is 3000; stay under it after escaping. */
const SECTION_MAX = 2900;

/**
 * Cut ALREADY-escaped text to `max`, never inside an entity: every `&` in escaped text starts
 * `&amp;`, `&lt;` or `&gt;`, so a cut tail matching `&[a-z]*` is a half entity and is dropped.
 * (Truncating before escaping let each `&` grow 5x past the cap: Slack answered `invalid_blocks`.)
 */
function clip(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  return `${escaped.slice(0, max).replace(/&[a-z]*$/, '')}…`;
}

const line = (text: string): string => clip(escapeMrkdwn(text), LINE_MAX);
/** A section whose text is capped after escaping, so no digest section can be refused as too long. */
const sec = (text: string): SlackBlock => section(clip(text, SECTION_MAX));
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
    sec(lines.join('\n')),
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
      sec(
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
    blocks.push(divider(), sec('*Needs a yes*'));
    for (const p of d.needsYes.slice(0, MAX_ITEMS)) {
      blocks.push(
        sec(
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
    blocks.push(divider(), sec('*Started by the agent*'));
    for (const i of d.agentInitiatives.slice(0, MAX_ITEMS)) {
      blocks.push(
        sec(`\`${escapeMrkdwn(i.id)}\``),
        actions(
          button('Keep', 'keep', i.id, 'primary'),
          button('Make it mine', 'make_mine', i.id),
          button('Stop', 'stop', i.id, 'danger'),
        ),
      );
    }
  }
  if (d.briefs.length) {
    blocks.push(divider(), sec('*Briefs ready*'));
    for (const b of d.briefs.slice(0, MAX_ITEMS)) blocks.push(...briefBlocks(b));
  }
  if (d.questions.length) {
    blocks.push(
      divider(),
      sec(
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
      sec(
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

import { context, divider, escapeMrkdwn, header, section, sectionFields, truncate, } from './shared';
export function personalityBlocks(binding) {
    const subject = binding.type === 'team' ? 'team coordinator' : 'personality';
    return [
        header('Bot binding'),
        section(`This bot is bound to the *${subject}* \`${binding.name}\`.`),
        context([
            binding.type === 'team'
                ? 'Talking to this bot routes through the team coordinator. Member subprocesses run in the background.'
                : 'Personality switching via `/personality` is disabled for identity-bound bots.',
        ]),
    ];
}
// Per-section caps so one field can't blow past Slack's ~3000-char section
// limit. Tool and skill lists are the only unbounded inputs here.
const TOOLS_MAX = 1500;
const SKILLS_MAX = 1500;
export function personalityRichBlocks(card) {
    const blocks = [header(card.name)];
    // Identity — description plus the personality's own SOUL.md voice (italic).
    const identityLines = [];
    if (card.description)
        identityLines.push(escapeMrkdwn(card.description));
    if (card.prose)
        identityLines.push(`_${escapeMrkdwn(card.prose)}_`);
    if (identityLines.length > 0)
        blocks.push(section(identityLines.join('\n')));
    blocks.push(divider());
    // Routing + memory — two-column grid.
    blocks.push(sectionFields([
        `*Runs on*\n${escapeMrkdwn(card.model)}\nvia ${escapeMrkdwn(card.provider)}`,
        '*Remembers*\nMEMORY.md · USER.md',
    ]));
    blocks.push(divider());
    // What it can do — tools.
    const toolCount = card.toolset.length;
    const toolList = toolCount > 0
        ? truncate(card.toolset.map((t) => escapeMrkdwn(t)).join(' · '), TOOLS_MAX)
        : '_No tools — this personality can only converse._';
    blocks.push(section(`*What it can do* — ${toolCount} tool${toolCount === 1 ? '' : 's'}\n${toolList}`));
    blocks.push(divider());
    // What it knows — resolved skills, tagged with provenance.
    const skillCount = card.skills.length;
    const skillList = skillCount > 0
        ? truncate(card.skills.map((s) => `✓ \`${escapeMrkdwn(s.id)}\`  _(${s.source})_`).join('\n'), SKILLS_MAX)
        : '_No skills resolved for this personality._';
    blocks.push(section(`*What it knows* — ${skillCount} skill${skillCount === 1 ? '' : 's'}\n${skillList}`));
    blocks.push(context([
        'Bound bot · personality switching is disabled · run `/ethos personality` for the short version',
    ]));
    return blocks;
}

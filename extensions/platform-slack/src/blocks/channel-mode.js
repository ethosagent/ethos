import { context, header, section } from './shared';
export function channelModeShowBlocks(input) {
  const { channel, mode, isOverride } = input;
  const source = isOverride ? 'per-channel override' : 'app default';
  return [
    header(`Channel mode: ${mode}`),
    section(`<#${channel}> currently uses *${mode}* (${source}).`),
    context([
      `Set with: \`/ethos channel-mode all\`, ` +
        `\`/ethos channel-mode thread_follow\`, or ` +
        `\`/ethos channel-mode mention_only\`.`,
    ]),
  ];
}
export function channelModeSetBlocks(input) {
  return [section(`Channel mode for <#${input.channel}> set to *${input.mode}*.`)];
}
export function channelModeUsageBlocks() {
  return [
    section(
      'Usage: `/ethos channel-mode show` ' +
        '· `/ethos channel-mode all` ' +
        '· `/ethos channel-mode thread_follow` ' +
        '· `/ethos channel-mode mention_only`',
    ),
  ];
}

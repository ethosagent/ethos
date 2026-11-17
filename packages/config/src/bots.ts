import type { BotBinding } from './builders/platforms';
import type { EthosConfig } from './config-types';

/**
 * Apply the legacy → list-shape shim. Configs written before multi-bot
 * routing kept a scalar `telegramToken`/`slack*` triple; synthesize a
 * one-entry `telegram.bots` / `slack.apps` so downstream code sees one
 * shape. Returns the deprecation messages the caller should surface.
 *
 * Legacy bots always bind to `config.personality` — never to
 * `config.activeContext`. `activeContext` is internal, mutable CLI/session
 * state (managed by `ethos set`); routing platform traffic by it would
 * mean a `/personality` switch in the CLI silently redirects Telegram or
 * Slack traffic after the next restart. Operators who want a team-bound
 * legacy bot must migrate to the explicit list shape.
 */
export function applyPlatformShim(config: EthosConfig): {
  config: EthosConfig;
  deprecations: string[];
} {
  const deprecations: string[] = [];
  let out = config;

  if (config.telegramToken && (config.telegram?.bots?.length ?? 0) === 0) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = { ...out, telegram: { bots: [{ token: config.telegramToken, bind }] } };
    deprecations.push(
      "Config field 'telegramToken' is deprecated. Use the list form: " +
        "'telegram.bots.0.token: <token>' + 'telegram.bots.0.bind.type: personality' + " +
        "'telegram.bots.0.bind.name: <id>'.",
    );
  }

  if (
    config.slackBotToken &&
    config.slackAppToken &&
    config.slackSigningSecret &&
    (config.slack?.apps?.length ?? 0) === 0
  ) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = {
      ...out,
      slack: {
        apps: [
          {
            botToken: config.slackBotToken,
            appToken: config.slackAppToken,
            signingSecret: config.slackSigningSecret,
            bind,
          },
        ],
      },
    };
    deprecations.push(
      "Config fields 'slackBotToken'/'slackAppToken'/'slackSigningSecret' are deprecated. " +
        "Use the list form: 'slack.apps.0.botToken: <token>' + " +
        "'slack.apps.0.appToken: <token>' + 'slack.apps.0.signingSecret: <secret>' + " +
        "'slack.apps.0.bind.type: personality' + 'slack.apps.0.bind.name: <id>'.",
    );
  }

  return { config: out, deprecations };
}

// Identifiers (bot id, bind.name, team key) are interpolated into the
// dotted line-based config format. Anything outside `[A-Za-z0-9_-]` either
// can't round-trip (dot = field separator) or quietly corrupts the file
// (`#` starts a comment, quotes change quoting semantics, whitespace
// truncates parsing). Reject up front so writeConfig never emits data it
// can't parse back unambiguously.
const SAFE_IDENT = /^[A-Za-z0-9_-]+$/;

export function rejectUnsafeIdent(label: string, value: string, errors: string[]): void {
  if (!SAFE_IDENT.test(value)) {
    errors.push(
      `${label}: '${value}' must match /^[A-Za-z0-9_-]+$/ — dots, whitespace, '#', and quotes are reserved by the config format.`,
    );
  }
}

/**
 * Does a bot binding speak for `personalityId` — directly, or because the bot
 * is bound to a team that contains it?
 *
 * This is the authorization predicate behind channel-addressable cron delivery
 * (plan/phases/recipes-gallery.md §1, refusal rule 1): it is what stops
 * personality A's scheduled output being delivered through personality B's
 * bot. It lives here, next to `validateBotBindings`, because both the web API's
 * delivery-target resolver and the gateway's delivery guard must agree on it —
 * two copies of a security rule is two rules.
 *
 * `teamMembers` resolves a team name to its member personality ids. Callers
 * that cannot read team manifests (or deployments with no teams) pass one that
 * returns an empty list; a `team` bind then resolves to nothing rather than to
 * everything.
 */
export function bindResolvesToPersonality(
  bind: BotBinding,
  personalityId: string,
  teamMembers: (teamName: string) => readonly string[],
): boolean {
  if (bind.type === 'personality') return bind.name === personalityId;
  return teamMembers(bind.name).includes(personalityId);
}

import { writeFileSync } from 'node:fs';

// `ethos slack manifest` — generate the Slack app manifest the operator
// pastes into api.slack.com → Your Apps → Create New App → "From a manifest".
//
// Why ship this:
// - Reduces onboarding from "what scopes do I need?" → 30s copy-paste.
// - Keeps the manifest in lockstep with what the adapter actually requires
//   (scopes, slash command names, event subscriptions). When we change the
//   adapter (e.g. add files:read for attachments), the manifest reflects
//   it in the next CLI release rather than drifting in user docs.
// - Avoids the "the bot is missing X scope" support ticket loop.
//
// Subcommands:
//   ethos slack manifest          — print JSON to stdout (default)
//   ethos slack manifest --yaml   — print YAML (Slack's preferred form)
//   ethos slack manifest -o <f>   — write to file instead of stdout
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};
const USAGE =
  'Usage: ethos slack [manifest [--yaml] [-o <file>] [--name <appname>] [--request-url <url>]]';
export async function runSlackManifest(args) {
  const sub = args[0] ?? 'manifest';
  if (sub !== 'manifest') {
    console.error(`${c.red}Unknown subcommand: ${sub}${c.reset}\n${USAGE}`);
    process.exit(1);
  }
  const sliced = args.slice(1);
  const asYaml = sliced.includes('--yaml');
  const outIdx = sliced.findIndex((a) => a === '-o' || a === '--output');
  const outPath = outIdx >= 0 ? sliced[outIdx + 1] : undefined;
  const nameIdx = sliced.indexOf('--name');
  const appName = nameIdx >= 0 ? sliced[nameIdx + 1] : 'Ethos Agent';
  const reqUrlIdx = sliced.indexOf('--request-url');
  const requestUrl = reqUrlIdx >= 0 ? sliced[reqUrlIdx + 1] : undefined;
  const manifest = buildManifest({ appName: appName ?? 'Ethos Agent', requestUrl });
  const serialized = asYaml ? toYaml(manifest) : JSON.stringify(manifest, null, 2);
  if (outPath) {
    writeFileSync(outPath, `${serialized}\n`, 'utf-8');
    console.log(`${c.green}✓ Wrote ${asYaml ? 'YAML' : 'JSON'} manifest → ${outPath}${c.reset}`);
    printPasteInstructions();
  } else {
    process.stdout.write(`${serialized}\n`);
    process.stderr.write(
      `\n${c.dim}(copy the block above; ${c.bold}-o <file>${c.reset}${c.dim} to write instead)${c.reset}\n`,
    );
    printPasteInstructions(true);
  }
}
function printPasteInstructions(toStderr = false) {
  const write = toStderr ? (s) => process.stderr.write(`${s}\n`) : console.log;
  write('');
  write(`${c.bold}Next steps:${c.reset}`);
  write(`${c.dim}  1.${c.reset} Visit ${c.cyan}https://api.slack.com/apps?new_app=1${c.reset}`);
  write(
    `${c.dim}  2.${c.reset} Pick ${c.bold}"From a manifest"${c.reset} and select your workspace`,
  );
  write(`${c.dim}  3.${c.reset} Paste the manifest above`);
  write(
    `${c.dim}  4.${c.reset} Click ${c.bold}"Create"${c.reset}, then ${c.bold}"Install to Workspace"${c.reset}`,
  );
  write(
    `${c.dim}  5.${c.reset} Copy the bot/app/signing values into ${c.cyan}~/.ethos/config.yaml${c.reset}:`,
  );
  write(`${c.dim}       slack.apps.0.botToken      ← Bot User OAuth Token (xoxb-…)${c.reset}`);
  write(`${c.dim}       slack.apps.0.appToken      ← App-Level Token (xapp-…)${c.reset}`);
  write(`${c.dim}       slack.apps.0.signingSecret ← Signing Secret${c.reset}`);
}
function buildManifest(opts) {
  // Slack app manifest schema reference:
  // https://api.slack.com/reference/manifests
  return {
    display_information: {
      name: opts.appName,
      description: 'An Ethos agent personality answering in Slack.',
      // background_color omitted — operators can set it in the Slack
      // admin UI. Inline hex literals trip the design-tokens gate.
    },
    features: {
      bot_user: {
        display_name: opts.appName,
        always_online: true,
      },
      slash_commands: SLASH_COMMANDS.map((cmd) => ({
        command: cmd.command,
        description: cmd.description,
        usage_hint: cmd.usage_hint,
        should_escape: false,
        // request_url is required only when not using socket mode.
        // Ethos's adapter runs in socket mode, but operators who want
        // an HTTP request URL can pass --request-url to populate it.
        ...(opts.requestUrl ? { url: opts.requestUrl } : {}),
      })),
    },
    oauth_config: {
      scopes: {
        bot: BOT_SCOPES,
      },
    },
    settings: {
      event_subscriptions: {
        // Socket-mode adapters don't need request_url for events either.
        bot_events: BOT_EVENTS,
        ...(opts.requestUrl ? { request_url: opts.requestUrl } : {}),
      },
      interactivity: {
        is_enabled: true,
        ...(opts.requestUrl ? { request_url: opts.requestUrl } : {}),
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
// Keep this list in lockstep with extensions/platform-slack/src/commands/.
// If you add a new slash subcommand there, mirror it here so the
// manifest stays correct.
const SLASH_COMMANDS = [
  {
    command: '/ethos',
    description: 'Talk to the Ethos agent or manage personalities, memory, kanban',
    usage_hint: 'ask <prompt> | personality [<id>] | memory [show|add] | kanban | help',
  },
];
// Minimum bot scopes the Ethos adapter needs.
// - chat:write: post messages, send approval cards
// - chat:write.public: post to channels the bot isn't a member of
// - app_mentions:read: receive @mention events
// - im:history / im:read / im:write: DMs
// - channels:history / groups:history: read public + private channel messages the bot is in
// - commands: slash command receipt
// - files:read: download user-attached files for vision_analyze / read_file
// - reactions:write: receipt reactions on inbound messages
// - users:read: resolve user IDs to names in approval cards / mentions
const BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'chat:write.public',
  'commands',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'mpim:write',
  'reactions:write',
  'users:read',
];
// Bot events the adapter subscribes to. Mirrors the Bolt event handlers
// registered in extensions/platform-slack/src/index.ts.
const BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
];
// ---------------------------------------------------------------------------
// YAML serializer — handwritten for the small manifest shape we emit so we
// don't pull in a YAML dependency just for one command.
// ---------------------------------------------------------------------------
function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    // Quote when contains chars that need escaping in a bare scalar.
    return /[:#{}[\],&*!|>'"%@`?\n]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        if (typeof item === 'object' && item !== null) {
          return `${pad}- ${rendered.replace(/^\s+/, '')}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        if (typeof v === 'object' && v !== null) {
          const rendered = toYaml(v, indent + 1);
          if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
          if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${k}: {}`;
          return `${pad}${k}:\n${rendered}`;
        }
        return `${pad}${k}: ${toYaml(v, indent)}`;
      })
      .join('\n');
  }
  return String(value);
}

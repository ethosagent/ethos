import { deriveBotKey, type EthosConfig } from '@ethosagent/config';

// ---------------------------------------------------------------------------
// Inbound spool (plan reach-and-containment §2.6)
// ---------------------------------------------------------------------------

export interface InboundSpoolReport {
  /** `absent` — no spool file yet (no gateway has run), not a failure. */
  status: 'absent' | 'ok' | 'failed';
  error?: string;
  counts?: {
    received: number;
    processing: number;
    done: number;
    dead: number;
    interrupted: number;
  };
  /** Age of the oldest owed (`received`) row, ms. */
  oldestReceivedAgeMs?: number;
  /** `received` rows for a botKey the config no longer names. `null` when the
   *  configured bots could not be determined. */
  orphaned?: Array<{ id: string; platform: string; botKey: string; chatId: string }> | null;
  dead?: Array<{
    id: string;
    platform: string;
    chatId: string;
    attempts: number;
    lastError: string | null;
  }>;
  /** Cut after a tool had started, so never replayed (plan openclaw-9.5-adoption
   *  D5): waiting on the user's `retry`, or an operator's replay/discard. */
  interrupted?: Array<{
    id: string;
    platform: string;
    chatId: string;
    lastError: string | null;
  }>;
}

/** The botKeys a gateway started from `config` would serve — the same
 *  derivations `ethos gateway start` uses. Legacy scalars are included. */
export async function configuredGatewayBotKeys(config: EthosConfig): Promise<string[]> {
  const { discordBotKey, emailBotKey, whatsAppBotKey } = await import('./gateway');
  const keys = new Set<string>();
  for (const b of config.telegram?.bots ?? []) keys.add(deriveBotKey(b));
  for (const a of config.slack?.apps ?? []) keys.add(deriveBotKey(a));
  for (const w of config.whatsapp ?? []) keys.add(whatsAppBotKey(w));
  if (config.telegramToken) keys.add(deriveBotKey({ token: config.telegramToken }));
  if (config.discordToken) keys.add(discordBotKey(config.discordToken));
  if (config.emailUser && config.emailImapHost) {
    keys.add(emailBotKey(config.emailUser, config.emailImapHost));
  }
  // The idle single-loop gateway (no platform) files everything under 'default'.
  keys.add('default');
  return [...keys];
}

/** The human lines for the "Inbound spool" block (colour-free; the caller
 *  prefixes marks). Up to 10 dead rows are listed, then a count. */
export function describeInboundSpool(report: InboundSpoolReport): string[] {
  if (report.status === 'absent')
    return ['–  No inbound spool yet (created by ethos gateway start).'];
  if (report.status === 'failed') return [`✗  inbound-spool.db failed to open: ${report.error}`];
  const n = report.counts ?? { received: 0, processing: 0, done: 0, dead: 0, interrupted: 0 };
  const lines = [
    `✓  ${n.received} owed · ${n.processing} in progress · ${n.done} done · ${n.dead} dead · ${n.interrupted} interrupted`,
  ];
  if (report.oldestReceivedAgeMs !== undefined) {
    lines.push(
      `   oldest owed message: ${Math.round(report.oldestReceivedAgeMs / 60_000)} min old`,
    );
  }
  if (report.orphaned === null) {
    lines.push('   orphaned rows: unknown (configured bots could not be read)');
  } else if (report.orphaned && report.orphaned.length > 0) {
    lines.push(
      `⚠  ${report.orphaned.length} owed message(s) for a bot no longer configured — re-add the bot to deliver them:`,
    );
    for (const o of report.orphaned.slice(0, 10)) {
      lines.push(`   ${o.id}  ${o.platform}:${o.chatId}  bot ${o.botKey}`);
    }
  }
  const dead = report.dead ?? [];
  if (dead.length > 0) {
    lines.push(`⚠  ${dead.length} dead letter(s):`);
    for (const d of dead.slice(0, 10)) {
      lines.push(
        `   ${d.id}  ${d.platform}:${d.chatId}  attempts ${d.attempts}  ${d.lastError ?? ''}`,
      );
    }
    if (dead.length > 10) lines.push(`   … and ${dead.length - 10} more`);
    lines.push(
      '   Replay with: ethos gateway spool replay <id>   Drop with: ethos gateway spool discard <id>',
    );
  }
  const interrupted = report.interrupted ?? [];
  if (interrupted.length > 0) {
    lines.push(
      `⚠  ${interrupted.length} interrupted message(s) — cut after an action started, so not replayed; each chat was asked to reply \`retry\`:`,
    );
    for (const r of interrupted.slice(0, 10)) {
      lines.push(`   ${r.id}  ${r.platform}:${r.chatId}  ${r.lastError ?? ''}`);
    }
    if (interrupted.length > 10) lines.push(`   … and ${interrupted.length - 10} more`);
    lines.push(
      '   Re-run anyway with: ethos gateway spool replay <id>   Drop with: ethos gateway spool discard <id>',
    );
  }
  return lines;
}
